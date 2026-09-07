# Autonomous Job Hunter

An autonomous, recurring and auditable job-search agent. Claude Code drives the pipeline through project skills and `/loop`; a purpose-built **Model Context Protocol (MCP) server** exposes SQLite as the transactional source of truth through typed tools only (no raw SQL); an Obsidian vault maintained by [obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain) is the qualitative "second brain" (profile, strategy, company research, per-cycle reports).

The user-facing side of the agent (interview, reports, hand-offs) speaks **Spanish (Mexico)** by design; code, identifiers and this README are in English. Change the language in `CLAUDE.md` and the skills if you fork it.

> Status: working system, used daily by its author for a real job search since 2026-09-05. Every phase of the roadmap is implemented except automatic submission: infrastructure, interview, discovery, analysis and scoring, research, preparation with manual hand-off, market intelligence and self-maintenance. Automatic submission (phase 7) is only implemented for sources whose official API allows it; today every source is `discover_only`, so the agent prepares the application package and the human sends it.

## What it does, once per scheduled slot

```
load state -> discover (public APIs / ATS boards) -> normalize -> dedupe -> extract skills
  -> extract compensation -> score against the candidate profile -> research top companies
  -> select -> prepare application package -> submit (only where permitted) -> record
  -> market intelligence -> update the vault -> report -> persist + release lock
```

Every cycle is a `search_run` with a persistent lock, heartbeats, recovery of interrupted runs and a report note in the vault. Each job gets a short code `VAC-<run>.<job>` (for example `VAC-1.119`) so humans and the agent can refer to it without URLs.

## Design decisions

- **Typed MCP tools, never `execute_sql`.** 55 tools with zod-validated inputs, parameterized queries and transactions: jobs, companies, skills, compensation, candidate profile, matching, runs and schedule, applications, research, market snapshots.
- **Explicit vs expected, always separate.** A skill is `explicit_required`, `explicit_preferred`, `mentioned` or `expected` (inferred, with confidence). A compensation observation is `explicit` (published) or `expected` (estimated, with methodology). Statistics never mix them.
- **Explainable scoring with hard constraints.** Eleven weighted factors (technical, required skills, experience, seniority, leadership, location, language, compensation with currency conversion, industry, responsibilities, preferences), renormalized over the factors that apply to a posting; every factor carries its explanation. Hard constraints (minimum salary, work mode, country, work authorization, required skill, employment type) veto regardless of score. Threshold and weights live in `config/jobhunt.yaml`.
- **Application state machine.** `DISCOVERED -> MATCHED -> SELECTED -> PREPARING -> READY -> SUBMITTING -> SUBMITTED` plus `REQUIRES_USER_INPUT`, `SKIPPED`, `REJECTED`, `FAILED`, `BLOCKED`, `EXPIRED`, `WITHDRAWN` and the funnel states after submission. Transitions are validated; events are append-only.
- **Idempotency everywhere.** The same posting seen twice (even from two sources) is one job with a version history; the same job can only ever have one application; a retried run cannot submit twice.
- **Rules that live in code, not in prompts.** Per-source rate limits and retries, at most 3 automatic submissions per source per run, one application per job, `check_can_submit` before any submission, sources with `automation_policy: blocked` are never queried.
- **External content is data, never instructions.** Postings, web pages, forms and emails are untrusted; the skills repeat this explicitly.
- **Never invent.** Experience, certifications, employers, technologies and answers to mandatory questions come from the interviewed profile or the application goes to `REQUIRES_USER_INPUT`.
- **Respect the sources.** Only official APIs, public ATS boards (Greenhouse, Lever, Ashby, Workday career sites), RSS feeds and career pages. No CAPTCHA or bot-detection bypass, no logins, no scraping against terms of service. LinkedIn and Indeed are `blocked`; amazon.jobs is disabled because its terms prohibit automated access.

## Architecture

```
Claude Code (agent / orchestrator)
  |-- .claude/skills/*        reasoning, decisions, writing (Spanish output)
  |-- /loop                   self-scheduled recurrence (Mon-Fri 07:00 / 13:00 / 19:00 by default)
  `-- MCP
       |-- jobhunt-db (this repo, TypeScript)   SQLite: transactional + analytical state
       `-- vault (obsidian-second-brain plugin)  read/search/write the Obsidian vault

Obsidian vault (second brain)         SQLite (data/jobhunt.db, WAL)
  Career/                              sources, companies, jobs, job_versions
  Job Search/ (Job Matches, reports)   skills, skill_aliases, job_skills, compensation_observations
  Market Intelligence/                 candidate_profile, candidate_skills, candidate_preferences
  Logs/YYYY-MM-DD.md                   job_matches, search_runs, run_source_results, run_errors
                                       applications, application_events, company_research
                                       market_snapshots, run_locks, system_state
```

Full design document: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Spanish). Deployment on a VPS with systemd or Docker: [deploy/README.md](deploy/README.md).

### Code layout

| Path | Contents |
|---|---|
| `src/config` | YAML configuration validated with zod, `.env` loading |
| `src/db` | schema and migrations, typed repositories (jobs, skills, compensation, profile, matches, applications, runs, research, market) |
| `src/core` | normalization and deduplication, skill taxonomy, scoring, application state machine, locks, run manager, rescoring |
| `src/sources` | source adapters (`JobSource { key, fetch, verify?, submit? }`) with a per-source HTTP client (rate limiter, retries with backoff, `Retry-After`) |
| `src/mcp` | the `jobhunt-db` MCP server (stdio) |
| `src/cli.ts` | operational CLI |
| `.claude/skills` | the agent's operating procedures: interview, run, discover, analyze, score, research, prepare, submit, review, market, maintain |
| `config/jobhunt.yaml` | schedule, scoring weights and threshold, FX rates, application limits, sources and their policies |
| `deploy/` | systemd unit and timer, Dockerfile |
| `tests/` | vitest suite (normalization, dedup, skills, compensation, scoring, state machine, runs, schedule, MCP, sources, codes) |

Sources implemented: Remotive, Remote OK, Arbeitnow, Hacker News "Who is hiring" (Algolia API), We Work Remotely (RSS), Himalayas (API), Greenhouse / Lever / Ashby job boards, Workday-hosted career sites.

## Quick start

Requirements: Node.js 22+ (tested on 24), npm, Git, an authenticated Claude Code CLI, and `uv` with Python 3.10+ (used by obsidian-second-brain).

```bash
git clone https://github.com/snivs/jobhunt.git && cd jobhunt
bash scripts/setup.sh
```

`setup.sh` installs dependencies, builds the MCP server, applies migrations, installs the obsidian-second-brain plugin, creates the vault (`vault/`, its own git repository) and runs the tests. On Windows use Git Bash. Set `JOBHUNT_OWNER_NAME` in `.env` before running it so the vault is created for you.

Then, inside Claude Code in the project folder (the `jobhunt-db` server is registered in `.mcp.json`):

1. `/jobhunt-interview` - structured interview; without a validated profile the pipeline refuses to search or apply.
2. `/jobhunt-run` - one manual cycle.
3. `/loop /jobhunt-run` - keep it running; it self-schedules to the slots in `config/jobhunt.yaml`.

## Skills

| Skill | Responsibility |
|---|---|
| `jobhunt-run` | one full pipeline cycle and the wait until the next slot |
| `jobhunt-interview` | structured interview; persists the profile to the vault and SQLite |
| `discover-jobs` | run source adapters, normalize, dedupe, record |
| `analyze-job` | deep analysis of one posting (explicit vs inferred skills, explicit vs estimated compensation) |
| `score-job` | explainable scoring and rescoring |
| `research-company` | company research with evidence levels (verified / inferred / unknown) |
| `prepare-application` | CV variant, answers, cover letter; never invents anything |
| `submit-application` | submission only through permitted methods, at most 3 per source per run |
| `review-applications` | application status, user feedback, learning |
| `market-analysis` | skill demand, compensation, sources, funnel |
| `maintain-job-system` | database, vault, locks and configuration health |

## CLI

```bash
npm run jobhunt -- db:status
npm run jobhunt -- schedule:status
npm run jobhunt -- discover --run-id 1 --query "senior typescript,engineering manager"
npm run jobhunt -- rescore --run-id 1
npm run jobhunt -- job:show VAC-1.119
npm run jobhunt -- run:show --id 1
npm run jobhunt -- stats --days 30
```

## Configuration

Everything variable is in [config/jobhunt.yaml](config/jobhunt.yaml): schedule and time zone, scoring weights and threshold, FX rates used only to compare published ranges with the candidate's currency, application limits, per-source automation policy, rate limits and retries, vault and database paths. The versioned file ships with example boards; keep your real target companies in a private copy (`config/jobhunt.local.yaml` is gitignored) and point `JOBHUNT_CONFIG_PATH` at it in `.env`. Secrets go in `.env` only (see `.env.example`); they are never written to SQLite, Markdown, logs or git.

## Development

```bash
npm run typecheck
npm test
npm run build      # required after changing the MCP server (.mcp.json runs dist/)
```

## License

MIT. See [LICENSE](LICENSE).
