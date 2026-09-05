import type { LoadedConfig, SourceConfig } from "../config/index.js";
import { ingestRawJob } from "../core/ingest.js";
import { normalizeText } from "../core/normalize.js";
import { nowIso } from "../core/time.js";
import type { DB } from "../db/index.js";
import { expireStaleJobs, getJob, updateJob, type JobRow } from "../db/repositories/jobs.js";
import { getPreferences, getProfileRow } from "../db/repositories/profile.js";
import { recordRunError, recordSourceResult, updateRunStats } from "../db/repositories/runs.js";
import { markSourceRun, requireSource } from "../db/repositories/sources.js";
import { errorToString, type Logger } from "../logging/index.js";
import { HttpClient, SourceHttpError } from "./http.js";
import { getAdapter } from "./index.js";
import type { SourceContext, VerifyResult } from "./types.js";

export interface SourceRunSummary {
  source: string;
  status: "success" | "failed" | "blocked" | "skipped" | "partial";
  jobs_found: number;
  jobs_new: number;
  jobs_updated: number;
  jobs_deduplicated: number;
  unchanged: number;
  compensation_recorded: number;
  expired: number;
  error: string | null;
  retry_count: number;
  duration_ms: number;
}

export interface DiscoveryOptions {
  runId: number | null;
  sourceKeys?: string[];
  terms?: string[];
  limit?: number;
  expireDays?: number;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

/** Search terms: explicit > candidate target_titles > current title > none (all postings). */
export function resolveSearchTerms(db: DB, explicit?: string[]): string[] {
  if (explicit && explicit.length) return explicit.map((t) => normalizeText(t)).filter(Boolean);
  const prefs = getPreferences(db);
  const titles = prefs.target_titles?.value;
  if (Array.isArray(titles) && titles.length) return titles.map((t) => normalizeText(String(t))).filter(Boolean);
  const profile = getProfileRow(db);
  if (profile?.current_title) return [normalizeText(profile.current_title)];
  return [];
}

function makeContext(config: SourceConfig, terms: string[], limit: number, logger: Logger, env: NodeJS.ProcessEnv): SourceContext {
  return { config, terms, limit, http: new HttpClient({ config, logger }), logger, env };
}

/** Runs every enabled, non-blocked source (or the requested ones). One source failing never stops the others. */
export async function runDiscovery(db: DB, config: LoadedConfig, opts: DiscoveryOptions): Promise<SourceRunSummary[]> {
  const terms = resolveSearchTerms(db, opts.terms);
  const env = opts.env ?? process.env;
  const summaries: SourceRunSummary[] = [];
  const wanted = opts.sourceKeys?.length ? config.sources.filter((s) => opts.sourceKeys!.includes(s.key)) : config.sources;
  for (const source of wanted) {
    const started = Date.now();
    const row = requireSource(db, source.key);
    const log = opts.logger.child(`source:${source.key}`, opts.runId);
    const base: SourceRunSummary = { source: source.key, status: "skipped", jobs_found: 0, jobs_new: 0, jobs_updated: 0, jobs_deduplicated: 0, unchanged: 0, compensation_recorded: 0, expired: 0, error: null, retry_count: 0, duration_ms: 0 };
    const finish = (s: SourceRunSummary): SourceRunSummary => {
      s.duration_ms = Date.now() - started;
      if (opts.runId) {
        recordSourceResult(db, { runId: opts.runId, sourceId: row.id, status: s.status, jobsFound: s.jobs_found, jobsNew: s.jobs_new, jobsUpdated: s.jobs_updated, jobsDeduplicated: s.jobs_deduplicated, error: s.error, retryCount: s.retry_count, startedAt: new Date(started).toISOString() });
      }
      summaries.push(s);
      return s;
    };
    if (source.automation_policy === "blocked") {
      finish({ ...base, status: "blocked", error: "automation_policy=blocked: not queried" });
      continue;
    }
    if (!source.enabled) {
      finish({ ...base, status: "skipped", error: "disabled in config" });
      continue;
    }
    const adapter = getAdapter(source.key);
    if (!adapter) {
      finish({ ...base, status: "skipped", error: "no adapter implemented" });
      continue;
    }
    if ((source.kind === "ats" || source.kind === "career_page") && source.boards.length === 0) {
      finish({ ...base, status: "skipped", error: "no boards configured" });
      continue;
    }
    const ctx = makeContext(source, terms, opts.limit ?? 200, log, env);
    try {
      log.info("discovery start", { terms, limit: ctx.limit });
      const raw = await adapter.fetch(ctx);
      const s: SourceRunSummary = { ...base, status: "success", jobs_found: raw.length };
      for (const job of raw) {
        try {
          const res = ingestRawJob(db, { ...job, sourceKey: source.key });
          if (res.outcome === "created") s.jobs_new++;
          else if (res.outcome === "updated") s.jobs_updated++;
          else if (res.outcome === "duplicate") s.jobs_deduplicated++;
          else s.unchanged++;
          if (res.compensation_recorded) s.compensation_recorded++;
        } catch (err) {
          s.status = "partial";
          recordRunError(db, { runId: opts.runId, source: source.key, operation: "ingest", error: errorToString(err), recoverable: true, details: { url: job.url } });
          log.warn("ingest failed", { url: job.url, error: errorToString(err) });
        }
      }
      if (raw.length > 0 && (opts.expireDays ?? 0) > 0) s.expired = expireStaleJobs(db, { sourceId: row.id, notSeenForDays: opts.expireDays! });
      s.retry_count = ctx.http.requests.retries;
      markSourceRun(db, row.id, { success: true });
      log.info("discovery done", { ...s });
      finish(s);
    } catch (err) {
      const message = errorToString(err);
      const retries = err instanceof SourceHttpError ? err.attempts - 1 : ctx.http.requests.retries;
      recordRunError(db, { runId: opts.runId, source: source.key, operation: "fetch", error: message, retryCount: retries, recoverable: !(err instanceof SourceHttpError) || err.retryable });
      markSourceRun(db, row.id, { success: false, error: message });
      log.error("discovery failed", { error: message, retries });
      finish({ ...base, status: "failed", error: message, retry_count: retries });
    }
  }
  if (opts.runId) {
    updateRunStats(db, opts.runId, {
      sources_processed: summaries.filter((s) => s.status !== "skipped").length,
      jobs_discovered: summaries.reduce((a, s) => a + s.jobs_found, 0),
      jobs_new: summaries.reduce((a, s) => a + s.jobs_new, 0),
      jobs_updated: summaries.reduce((a, s) => a + s.jobs_updated, 0),
      jobs_deduplicated: summaries.reduce((a, s) => a + s.jobs_deduplicated, 0),
      compensation_observations: summaries.reduce((a, s) => a + s.compensation_recorded, 0),
    });
  }
  return summaries;
}

/** Re-checks a posting through its source adapter and updates status/last_verified_at. */
export async function verifyJob(db: DB, config: LoadedConfig, jobId: number, logger: Logger): Promise<{ job: JobRow; result: VerifyResult }> {
  const job = getJob(db, jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const source = config.sources.find((s) => s.key === requireSourceKey(db, job.source_id));
  const adapter = source ? getAdapter(source.key) : undefined;
  if (!source || !adapter?.verify) return { job, result: "unknown" };
  const ctx = makeContext(source, [], 1, logger, process.env);
  let result: VerifyResult = "unknown";
  try {
    result = await adapter.verify(ctx, job);
  } catch (err) {
    logger.warn("verify failed", { job_id: jobId, error: errorToString(err) });
  }
  const now = nowIso();
  const updated = result === "expired" ? updateJob(db, jobId, { status: "expired", last_verified_at: now }) : result === "active" ? updateJob(db, jobId, { last_verified_at: now }) : job;
  return { job: updated, result };
}

function requireSourceKey(db: DB, sourceId: number): string {
  const row = db.prepare("SELECT key FROM sources WHERE id = ?").get(sourceId) as { key: string } | undefined;
  if (!row) throw new Error(`Source ${sourceId} not found`);
  return row.key;
}
