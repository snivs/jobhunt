import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";

export type RunTrigger = "scheduled" | "manual" | "loop" | "recovery";
export type RunStatus = "running" | "completed" | "failed" | "skipped" | "interrupted";

export const PIPELINE_STAGES = [
  "load_state",
  "load_candidate_context",
  "discover_jobs",
  "normalize",
  "deduplicate",
  "extract_skills",
  "extract_compensation",
  "score_jobs",
  "research_companies",
  "select_applications",
  "prepare_applications",
  "submit_applications",
  "record_results",
  "update_market_intelligence",
  "update_second_brain",
  "generate_report",
  "persist_state",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface RunRow {
  id: number;
  run_key: string;
  trigger: RunTrigger;
  status: RunStatus;
  current_stage: string | null;
  started_at: string;
  completed_at: string | null;
  stats_json: string;
  errors_json: string;
  report_path: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunStats {
  sources_processed?: number;
  jobs_discovered?: number;
  jobs_new?: number;
  jobs_updated?: number;
  jobs_deduplicated?: number;
  jobs_scored?: number;
  jobs_eligible?: number;
  applications_attempted?: number;
  applications_submitted?: number;
  applications_failed?: number;
  applications_blocked?: number;
  applications_requires_input?: number;
  skills_detected?: number;
  compensation_observations?: number;
  companies_researched?: number;
  errors?: number;
  [key: string]: number | string | undefined;
}

export interface RunView extends Omit<RunRow, "stats_json" | "errors_json"> {
  stats: RunStats;
  errors: RunErrorRow[];
}

export interface RunErrorRow {
  id: number;
  run_id: number | null;
  source: string | null;
  operation: string;
  error: string;
  timestamp: string;
  retry_count: number;
  recoverable: number;
  details_json: string | null;
}

export function toRunView(r: RunRow, errors: RunErrorRow[] = []): RunView {
  const { stats_json, errors_json, ...rest } = r;
  void errors_json;
  return { ...rest, stats: fromJson<RunStats>(stats_json, {}), errors };
}

/** Idempotent by run_key: creating a run with an existing key returns it instead of a duplicate. */
export function createRun(db: DB, input: { runKey: string; trigger: RunTrigger; notes?: string | null }): { run: RunView; created: boolean } {
  const now = nowIso();
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM search_runs WHERE run_key = ?").get(input.runKey) as RunRow | undefined;
    if (existing) return { run: getRun(db, existing.id)!, created: false };
    const res = db
      .prepare(
        `INSERT INTO search_runs (run_key, trigger, status, current_stage, started_at, stats_json, errors_json, notes, created_at, updated_at)
         VALUES (?, ?, 'running', 'load_state', ?, '{}', '[]', ?, ?, ?)`,
      )
      .run(input.runKey, input.trigger, now, input.notes ?? null, now, now);
    return { run: getRun(db, Number(res.lastInsertRowid))!, created: true };
  });
  return tx();
}

export function getRun(db: DB, id: number): RunView | null {
  const row = db.prepare("SELECT * FROM search_runs WHERE id = ?").get(id) as RunRow | undefined;
  if (!row) return null;
  const errors = db.prepare("SELECT * FROM run_errors WHERE run_id = ? ORDER BY timestamp").all(id) as RunErrorRow[];
  return toRunView(row, errors);
}

export function getRunByKey(db: DB, runKey: string): RunView | null {
  const row = db.prepare("SELECT * FROM search_runs WHERE run_key = ?").get(runKey) as RunRow | undefined;
  return row ? getRun(db, row.id) : null;
}

export function listRuns(db: DB, opts: { status?: RunStatus; limit?: number } = {}): RunView[] {
  const rows = opts.status
    ? (db.prepare("SELECT * FROM search_runs WHERE status = ? ORDER BY started_at DESC LIMIT ?").all(opts.status, opts.limit ?? 20) as RunRow[])
    : (db.prepare("SELECT * FROM search_runs ORDER BY started_at DESC LIMIT ?").all(opts.limit ?? 20) as RunRow[]);
  return rows.map((r) => toRunView(r));
}

export function updateRunStage(db: DB, runId: number, stage: PipelineStage | string, note?: string | null): RunView {
  db.prepare("UPDATE search_runs SET current_stage = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?").run(stage, note ?? null, nowIso(), runId);
  return getRun(db, runId)!;
}

/** Merges numeric stats additively (or replaces when `replace` is set). */
export function updateRunStats(db: DB, runId: number, patch: RunStats, opts: { replace?: boolean } = {}): RunView {
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT stats_json FROM search_runs WHERE id = ?").get(runId) as { stats_json: string } | undefined;
    if (!row) throw new Error(`Run ${runId} not found`);
    const current = fromJson<RunStats>(row.stats_json, {});
    const merged: RunStats = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (!opts.replace && typeof v === "number" && typeof current[k] === "number") merged[k] = (current[k] as number) + v;
      else merged[k] = v;
    }
    db.prepare("UPDATE search_runs SET stats_json = ?, updated_at = ? WHERE id = ?").run(toJson(merged), nowIso(), runId);
  });
  tx();
  return getRun(db, runId)!;
}

export function completeRun(db: DB, runId: number, input: { status: Exclude<RunStatus, "running">; stats?: RunStats; reportPath?: string | null; notes?: string | null }): RunView {
  const now = nowIso();
  const tx = db.transaction(() => {
    if (input.stats) updateRunStats(db, runId, input.stats, { replace: true });
    const errorCount = (db.prepare("SELECT COUNT(*) AS c FROM run_errors WHERE run_id = ?").get(runId) as { c: number }).c;
    updateRunStats(db, runId, { errors: errorCount }, { replace: true });
    db.prepare(
      "UPDATE search_runs SET status = ?, completed_at = ?, report_path = COALESCE(?, report_path), notes = COALESCE(?, notes), current_stage = CASE WHEN ? = 'completed' THEN 'persist_state' ELSE current_stage END, updated_at = ? WHERE id = ?",
    ).run(input.status, now, input.reportPath ?? null, input.notes ?? null, input.status, now, runId);
  });
  tx();
  return getRun(db, runId)!;
}

export function recordRunError(
  db: DB,
  input: { runId?: number | null; source?: string | null; operation: string; error: string; retryCount?: number; recoverable?: boolean; details?: Record<string, unknown> | null },
): RunErrorRow {
  const res = db
    .prepare(
      "INSERT INTO run_errors (run_id, source, operation, error, timestamp, retry_count, recoverable, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(input.runId ?? null, input.source ?? null, input.operation, input.error, nowIso(), input.retryCount ?? 0, input.recoverable === false ? 0 : 1, input.details ? toJson(input.details) : null);
  return db.prepare("SELECT * FROM run_errors WHERE id = ?").get(Number(res.lastInsertRowid)) as RunErrorRow;
}

export interface SourceResultInput {
  runId: number;
  sourceId: number;
  status: "success" | "failed" | "blocked" | "skipped" | "partial";
  jobsFound?: number;
  jobsNew?: number;
  jobsUpdated?: number;
  jobsDeduplicated?: number;
  error?: string | null;
  retryCount?: number;
  startedAt?: string;
}

export function recordSourceResult(db: DB, input: SourceResultInput): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO run_source_results (run_id, source_id, status, jobs_found, jobs_new, jobs_updated, jobs_deduplicated, error, retry_count, started_at, completed_at)
     VALUES (@run_id, @source_id, @status, @jobs_found, @jobs_new, @jobs_updated, @jobs_deduplicated, @error, @retry_count, @started_at, @now)
     ON CONFLICT(run_id, source_id) DO UPDATE SET status = excluded.status, jobs_found = excluded.jobs_found, jobs_new = excluded.jobs_new,
       jobs_updated = excluded.jobs_updated, jobs_deduplicated = excluded.jobs_deduplicated, error = excluded.error, retry_count = excluded.retry_count, completed_at = excluded.completed_at`,
  ).run({
    run_id: input.runId,
    source_id: input.sourceId,
    status: input.status,
    jobs_found: input.jobsFound ?? 0,
    jobs_new: input.jobsNew ?? 0,
    jobs_updated: input.jobsUpdated ?? 0,
    jobs_deduplicated: input.jobsDeduplicated ?? 0,
    error: input.error ?? null,
    retry_count: input.retryCount ?? 0,
    started_at: input.startedAt ?? now,
    now,
  });
}

export function getRunSourceResults(db: DB, runId: number): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT r.*, s.key AS source_key FROM run_source_results r JOIN sources s ON s.id = r.source_id WHERE r.run_id = ? ORDER BY s.key")
    .all(runId) as Array<Record<string, unknown>>;
}

export function getState<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare("SELECT value_json FROM system_state WHERE key = ?").get(key) as { value_json: string } | undefined;
  return row ? fromJson<T>(row.value_json, fallback) : fallback;
}

export function setState(db: DB, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
  ).run(key, toJson(value), nowIso());
}
