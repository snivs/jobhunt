#!/usr/bin/env node
/**
 * Operational CLI. Usage: npm run jobhunt -- <command> [--flag value]
 *   db:migrate                       apply pending migrations
 *   db:status                        migration status + row counts
 *   db:backup [--out path]           online backup of the SQLite file
 *   config:check                     validate config and print effective paths
 *   sources:sync                     upsert configured sources into the DB
 *   schedule:status                  next/due slot, lock and running runs
 *   run:list [--limit n]             recent runs
 *   run:show --id <id|key>           run details with errors and per-source results
 *   run:recover                      mark crashed runs as interrupted and free in-flight applications
 *   lock:status | lock:release --holder <h>
 *   profile:status                   whether the candidate profile/interview exists
 *   stats [--days n]                 market + application statistics
 *   discover --run-id <id> [--source key] [--query "a,b"] [--limit n] [--expire-days d] [--all]
 *   verify-job --job-id <id>         re-check a posting through its source adapter
 *   submit --application-id <id> --run-id <id>   submit through a permitted adapter (apply_allowed only)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { getLock, PIPELINE_LOCK, releaseLock } from "./core/lock.js";
import { getScheduleStatus, recoverInterruptedRuns } from "./core/run-manager.js";
import { daysAgoIso, nowIso } from "./core/time.js";
import { fromJson, migrationStatus, openDatabase } from "./db/index.js";
import { getApplication } from "./db/repositories/applications.js";
import { getJob } from "./db/repositories/jobs.js";
import { getMarketStatistics } from "./db/repositories/market.js";
import { getCandidateProfile, getPreferences } from "./db/repositories/profile.js";
import { getRun, getRunByKey, getRunSourceResults, listRuns } from "./db/repositories/runs.js";
import { getSourceById, syncSources } from "./db/repositories/sources.js";
import { Logger } from "./logging/index.js";
import { HttpClient } from "./sources/http.js";
import { getAdapter } from "./sources/index.js";
import { runDiscovery, verifyJob } from "./sources/runner.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function print(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function parseArgs(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function num(v: string | boolean | undefined, fallback?: number): number | undefined {
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  const config = loadConfig({ rootDir });
  if (!command || command === "help") {
    process.stdout.write(
      [
        "jobhunt CLI",
        "  db:migrate | db:status | db:backup [--out p] | config:check | sources:sync | schedule:status",
        "  run:list [--limit n] | run:show --id <id|key> | run:recover | lock:status | lock:release --holder h",
        "  profile:status | stats [--days n]",
        "  discover --run-id id [--source key] [--query a,b] [--limit n] [--expire-days d] [--all]",
        "  verify-job --job-id id | submit --application-id id --run-id id",
      ].join("\n") + "\n",
    );
    return 0;
  }
  const logger = new Logger({ dir: config.logging.dir, level: config.logging.level, component: `cli:${command}`, stderr: process.env.JOBHUNT_LOG_STDERR === "1" });
  const db = openDatabase({ dbPath: config.database.path, migrate: command !== "db:status" });
  try {
    switch (command) {
      case "db:migrate":
        print({ database: config.database.path, migrations: migrationStatus(db) });
        return 0;
      case "db:status": {
        const tables = ["sources", "companies", "jobs", "skills", "job_skills", "compensation_observations", "job_matches", "search_runs", "applications", "application_events", "company_research", "market_snapshots"];
        const counts: Record<string, number> = {};
        for (const t of tables) {
          try {
            counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
          } catch {
            counts[t] = -1;
          }
        }
        print({ database: config.database.path, migrations: migrationStatus(db), counts });
        return 0;
      }
      case "db:backup": {
        const out = typeof flags.out === "string" ? path.resolve(flags.out) : path.join(path.dirname(config.database.path), "backups", `jobhunt-${nowIso().replace(/[:.]/g, "-")}.db`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await db.backup(out);
        print({ backup: out });
        return 0;
      }
      case "config:check":
        print({ configPath: config.configPath, rootDir: config.rootDir, database: config.database.path, vault: config.vault.path, logs: config.logging.dir, schedule: config.schedule, matching: config.matching, applications: config.applications, sources: config.sources.map((s) => `${s.key} (${s.automation_policy}${s.enabled ? "" : ", disabled"}${s.boards.length ? `, boards: ${s.boards.join("|")}` : ""})`) });
        return 0;
      case "sources:sync":
        print(syncSources(db, config.sources));
        return 0;
      case "schedule:status":
        print(getScheduleStatus(db, config));
        return 0;
      case "run:list":
        print(listRuns(db, { limit: num(flags.limit, Number(positional[0] ?? 10)) }));
        return 0;
      case "run:show": {
        const key = typeof flags.id === "string" ? flags.id : positional[0];
        if (!key) throw new Error("run:show --id <id|key>");
        const run = /^\d+$/.test(key) ? getRun(db, Number(key)) : getRunByKey(db, key);
        if (!run) throw new Error(`Run ${key} not found`);
        print({ ...run, source_results: getRunSourceResults(db, run.id) });
        return 0;
      }
      case "run:recover":
        print({ recovered: recoverInterruptedRuns(db) });
        return 0;
      case "lock:status":
        print(getLock(db, PIPELINE_LOCK));
        return 0;
      case "lock:release": {
        const holder = typeof flags.holder === "string" ? flags.holder : positional[0];
        if (!holder) throw new Error("lock:release --holder <holder>");
        print({ released: releaseLock(db, PIPELINE_LOCK, holder) });
        return 0;
      }
      case "profile:status": {
        const p = getCandidateProfile(db);
        print(p ? { exists: true, interview_completed: p.profile.interview_completed === 1, version: p.profile.version, skills: p.skills.length, preferences: Object.keys(p.preferences) } : { exists: false });
        return 0;
      }
      case "stats":
        print(getMarketStatistics(db, { periodStart: daysAgoIso(num(flags.days, Number(positional[0] ?? config.market.snapshot_period_days))!), minSampleSize: config.market.min_sample_size }));
        return 0;
      case "discover": {
        const runId = num(flags["run-id"]) ?? null;
        const terms = flags.all ? [] : typeof flags.query === "string" ? flags.query.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const summaries = await runDiscovery(db, config, {
          runId,
          sourceKeys: typeof flags.source === "string" ? flags.source.split(",") : undefined,
          terms: flags.all ? [] : terms,
          limit: num(flags.limit, 200),
          expireDays: num(flags["expire-days"], 21),
          logger,
        });
        print({ run_id: runId, sources: summaries, totals: { jobs_found: summaries.reduce((a, s) => a + s.jobs_found, 0), jobs_new: summaries.reduce((a, s) => a + s.jobs_new, 0), jobs_updated: summaries.reduce((a, s) => a + s.jobs_updated, 0), jobs_deduplicated: summaries.reduce((a, s) => a + s.jobs_deduplicated, 0), failed: summaries.filter((s) => s.status === "failed").map((s) => s.source) } });
        return 0;
      }
      case "verify-job": {
        const jobId = num(flags["job-id"]);
        if (!jobId) throw new Error("verify-job --job-id <id>");
        const res = await verifyJob(db, config, jobId, logger);
        print({ job_id: jobId, result: res.result, status: res.job.status, last_verified_at: res.job.last_verified_at });
        return 0;
      }
      case "submit": {
        const applicationId = num(flags["application-id"]);
        const runId = num(flags["run-id"]);
        if (!applicationId || !runId) throw new Error("submit --application-id <id> --run-id <id>");
        const app = getApplication(db, applicationId);
        if (!app) throw new Error(`Application ${applicationId} not found`);
        const source = getSourceById(db, app.source_id)!;
        const sourceConfig = config.sources.find((s) => s.key === source.key);
        const adapter = getAdapter(source.key);
        if (source.automation_policy !== "apply_allowed" || !sourceConfig) {
          print({ ok: false, error: `Source ${source.key} does not permit automatic submission (policy ${source.automation_policy}); hand off to the user` });
          return 0;
        }
        if (!adapter?.submit) {
          print({ ok: false, error: `No permitted submission adapter implemented for ${source.key}; hand off to the user` });
          return 0;
        }
        if (app.status !== "SUBMITTING") {
          print({ ok: false, error: `Application must be in SUBMITTING state (is ${app.status}); run check_can_submit and record_application_event first` });
          return 0;
        }
        const job = getJob(db, app.job_id)!;
        const prefs = getPreferences(db);
        const contact = (prefs.contact?.value as Record<string, string> | undefined) ?? {};
        const result = await adapter.submit(
          { config: sourceConfig, terms: [], limit: 1, http: new HttpClient({ config: sourceConfig, logger }), logger, env: process.env },
          {
            applicationId,
            job,
            resumePath: app.resume_variant,
            coverLetterPath: app.cover_letter_path,
            answers: fromJson<Record<string, unknown>>(app.answers_json, {}),
            candidate: { fullName: getCandidateProfile(db)?.profile.full_name ?? null, email: contact.email ?? null, phone: contact.phone ?? null, links: contact },
          },
        );
        print(result);
        return 0;
      }
      default:
        throw new Error(`Unknown command ${command}`);
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
