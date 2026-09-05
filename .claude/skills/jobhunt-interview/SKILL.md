---
name: jobhunt-interview
description: Structured interview to build (or update) the candidate's professional profile before any job search. Persists narrative context to the Obsidian second brain and normalized fields to SQLite via the jobhunt-db MCP. Run automatically when no profile exists.
---

# jobhunt-interview

Goal: a profile deep enough to score jobs and prepare applications without inventing anything.
Conduct it in Spanish (Mexico). Ask in blocks (5-8 questions per message), confirm what you
understood before moving on, and accept "no se" / "prefiero no decir" as valid answers (store
them as `TBD`, never fill gaps yourself).

Before starting: `get_candidate_profile`. If a profile exists, show a summary and ask which
blocks to update instead of re-asking everything.

## Blocks (minimum coverage)

1. **Identidad profesional** - puesto actual, seniority, anos de experiencia, anos liderando,
   responsabilidades, tamano de equipos, tipos de proyectos, titulos objetivo.
2. **Tecnologia** - lenguajes, frameworks, bases de datos, cloud, DevOps/CI-CD, arquitectura,
   sistemas distribuidos, APIs, seguridad, IA/ML, LLMs, herramientas de agentes (Claude Code,
   MCP). For each: level (expert / advanced / intermediate / basic / learning), years, primary?
3. **Experiencia** - proyectos importantes, logros cuantificables, sistemas construidos,
   migraciones, incidentes resueltos, reduccion de costos, mejoras de rendimiento, automatizaciones.
   Capture employer, dates, role, metrics exactly as stated.
4. **Educacion** - estudios, certificaciones (with issuer/year), cursos relevantes.
5. **Idiomas** - espanol, ingles, otros; level per CEFR (A1..C2/native).
6. **Preferencias laborales** - remoto / hibrido / presencial, ubicacion, paises aceptables,
   viajes, reubicacion, horario, zona horaria, autorizacion de trabajo por region.
7. **Compensacion** - minimo aceptable, objetivo, moneda, periodo, salario actual (optional),
   beneficios importantes. Ask explicitly whether the minimum is a HARD constraint and what to
   do when a posting does not disclose salary.
8. **Tipo de empresa** - startup / scale-up / enterprise / consultoria / producto, industrias
   preferidas y evitadas, tamano.
9. **Responsabilidades** - que quiere hacer, que no, que esta dispuesto a aprender, que no acepta
   (hard constraints: on-call, presencialidad, tecnologias, horarios).
10. **Aplicaciones** - which information may be used automatically (name, email, phone, links,
    location, years, salary expectations?), which CV versions exist and where they live (path),
    which standard answers may be reused (work authorization, notice period, relocation),
    which fields ALWAYS need explicit approval. Also: target companies or ATS boards to watch
    (Greenhouse/Lever/Ashby board tokens), and sources to exclude.

## Persistence (after the user confirms the summary)

### Second brain (context, full narrative) - use obsidian-second-brain conventions
Vault root = `vault.path` from `get_config`. Write/update these AI-first notes (frontmatter with
`type`, `date`, `tags`, `ai-first: true`; `## For future agent` preamble; wikilinks; `TBD` for unknowns):

- `Career/Candidate Profile.md` (`type: candidate-profile`) - identity, summary, preferences,
  constraints, links to Experience, Skills, Search Strategy, Application Strategy.
- `Career/Experience.md` (`type: experience`) - one section per employer/project with dates,
  role, achievements with numbers, technologies (wikilinks to `Market Intelligence/Skills/<Skill>.md`).
- `Career/Skills.md` (`type: skills-inventory`) - table: skill, level, years, evidence (project).
- `Career/Education.md` (`type: education`).
- `Job Search/Search Strategy.md` (`type: search-strategy`) - target titles, sources, filters,
  hard constraints, rationale.
- `Job Search/Application Strategy.md` (`type: application-strategy`) - CV variants (paths),
  auto-fill policy, standard answers, approval rules, tone guidelines.
- Update `INDEX.md` links if any note is new. Append to `Logs/YYYY-MM-DD.md`.

Follow `/obsidian-save` semantics: search before creating, update instead of duplicating,
never delete. Do not store secrets (passwords, tokens) anywhere in the vault.

### SQLite (normalized, operational) - jobhunt-db tools
- `update_candidate_profile`: full_name, headline, current_title, seniority, years_experience,
  years_leadership, location, country, timezone, languages [{code, level}], work_authorization,
  vault_note: "Career/Candidate Profile.md", interview_completed: true (only at the end).
- `set_candidate_skill` for every skill (level, years, is_primary, willing_to_learn).
- `set_candidate_preference` for: work_modes, acceptable_countries, relocation, travel,
  compensation {minimum, target, currency, period}, industries_preferred, industries_avoided,
  responsibilities_wanted, responsibilities_unwanted, company_types_preferred,
  company_sizes_preferred, employment_types, target_titles, hard_constraints (extra items such
  as {type: "language", code: "en", minLevel: "b2"} or {type: "work_authorization", regions: [...]}),
  auto_apply_allowed_fields, requires_approval_fields, resume_variants [{name, path, use_for}],
  standard_answers {question: answer}, benefits_important, schedule.
  Set `is_hard_constraint: true` on work_modes / acceptable_countries / compensation /
  employment_types only when the user said they are non-negotiable.
- If the user named ATS boards, tell them to add the board tokens to `config/jobhunt.yaml`
  under the matching source (`boards: [...]`) and set `automation_policy` deliberately.

## Validation
Read back `get_candidate_profile` and show the user: seniority, years, skill count by level,
hard constraints, compensation, resume variants. Ask for a final "si" before marking
`interview_completed: true`. Then tell them the pipeline can start (`/jobhunt-run` or `/loop`).
