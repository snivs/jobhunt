import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";
import { getApplicationStatistics } from "./applications.js";
import { getCompensationStatistics } from "./compensation.js";
import { getSkillMarketDemand } from "./skills.js";

export type SnapshotKind = "skills" | "compensation" | "sources" | "funnel" | "summary";

export interface SnapshotRow {
  id: number;
  snapshot_date: string;
  period_start: string;
  period_end: string;
  kind: SnapshotKind;
  dimensions_json: string;
  data_json: string;
  run_id: number | null;
  created_at: string;
}

export function saveMarketSnapshot(db: DB, input: { kind: SnapshotKind; periodStart: string; periodEnd: string; dimensions?: Record<string, unknown>; data: unknown; runId?: number | null }): SnapshotRow {
  const now = nowIso();
  const res = db
    .prepare("INSERT INTO market_snapshots (snapshot_date, period_start, period_end, kind, dimensions_json, data_json, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(now.slice(0, 10), input.periodStart, input.periodEnd, input.kind, toJson(input.dimensions ?? {}), toJson(input.data), input.runId ?? null, now);
  return db.prepare("SELECT * FROM market_snapshots WHERE id = ?").get(Number(res.lastInsertRowid)) as SnapshotRow;
}

export function getMarketSnapshots(db: DB, opts: { kind?: SnapshotKind; limit?: number } = {}): Array<Omit<SnapshotRow, "data_json" | "dimensions_json"> & { data: unknown; dimensions: Record<string, unknown> }> {
  const rows = opts.kind
    ? (db.prepare("SELECT * FROM market_snapshots WHERE kind = ? ORDER BY snapshot_date DESC, id DESC LIMIT ?").all(opts.kind, opts.limit ?? 10) as SnapshotRow[])
    : (db.prepare("SELECT * FROM market_snapshots ORDER BY snapshot_date DESC, id DESC LIMIT ?").all(opts.limit ?? 10) as SnapshotRow[]);
  return rows.map((r) => {
    const { data_json, dimensions_json, ...rest } = r;
    return { ...rest, data: fromJson<unknown>(data_json, null), dimensions: fromJson<Record<string, unknown>>(dimensions_json, {}) };
  });
}

export interface SourceStatisticsRow {
  source_key: string;
  name: string;
  kind: string;
  automation_policy: string;
  enabled: number;
  jobs_discovered: number;
  jobs_relevant: number;
  applications: number;
  submitted: number;
  responses: number;
  errors: number;
  runs: number;
  failed_runs: number;
  last_success_at: string | null;
  last_error: string | null;
}

export function getSourceStatistics(db: DB, opts: { since?: string } = {}): SourceStatisticsRow[] {
  const params: Record<string, unknown> = { since: opts.since ?? "1970-01-01" };
  return db
    .prepare(
      `SELECT s.key AS source_key, s.name, s.kind, s.automation_policy, s.enabled,
         (SELECT COUNT(*) FROM jobs j WHERE j.source_id = s.id AND j.discovered_at >= @since) AS jobs_discovered,
         (SELECT COUNT(*) FROM jobs j JOIN v_latest_job_matches m ON m.job_id = j.id WHERE j.source_id = s.id AND m.eligible = 1 AND j.discovered_at >= @since) AS jobs_relevant,
         (SELECT COUNT(*) FROM applications a WHERE a.source_id = s.id AND a.created_at >= @since) AS applications,
         (SELECT COUNT(*) FROM applications a WHERE a.source_id = s.id AND a.created_at >= @since AND a.status IN ('SUBMITTED','RESPONSE_RECEIVED','INTERVIEW','OFFER','ACCEPTED','DECLINED','NO_RESPONSE')) AS submitted,
         (SELECT COUNT(*) FROM applications a WHERE a.source_id = s.id AND a.created_at >= @since AND a.status IN ('RESPONSE_RECEIVED','INTERVIEW','OFFER','ACCEPTED','DECLINED')) AS responses,
         (SELECT COUNT(*) FROM run_errors e WHERE e.source = s.key AND e.timestamp >= @since) AS errors,
         (SELECT COUNT(*) FROM run_source_results r WHERE r.source_id = s.id AND r.started_at >= @since) AS runs,
         (SELECT COUNT(*) FROM run_source_results r WHERE r.source_id = s.id AND r.started_at >= @since AND r.status IN ('failed','blocked')) AS failed_runs,
         s.last_success_at, s.last_error
       FROM sources s ORDER BY jobs_discovered DESC, s.key`,
    )
    .all(params) as SourceStatisticsRow[];
}

export interface MarketStatistics {
  period: { start: string; end: string };
  jobs: { total: number; by_work_mode: Record<string, number>; by_seniority: Record<string, number>; by_employment_type: Record<string, number>; by_country: Array<{ country: string; count: number }> };
  top_skills: ReturnType<typeof getSkillMarketDemand>;
  compensation: ReturnType<typeof getCompensationStatistics>;
  sources: SourceStatisticsRow[];
  applications: ReturnType<typeof getApplicationStatistics>;
}

export function getMarketStatistics(db: DB, opts: { periodStart: string; periodEnd?: string; currency?: string; minSampleSize?: number; topSkills?: number }): MarketStatistics {
  const end = opts.periodEnd ?? nowIso();
  const params = { start: opts.periodStart, end };
  const group = (col: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of db
      .prepare(`SELECT ${col} AS k, COUNT(*) AS c FROM jobs WHERE duplicate_of_job_id IS NULL AND discovered_at >= @start AND discovered_at < @end GROUP BY ${col}`)
      .all(params) as Array<{ k: string | null; c: number }>) {
      out[r.k ?? "unknown"] = r.c;
    }
    return out;
  };
  const total = (db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE duplicate_of_job_id IS NULL AND discovered_at >= @start AND discovered_at < @end").get(params) as { c: number }).c;
  const byCountry = db
    .prepare(
      "SELECT COALESCE(country, 'unknown') AS country, COUNT(*) AS count FROM jobs WHERE duplicate_of_job_id IS NULL AND discovered_at >= @start AND discovered_at < @end GROUP BY country ORDER BY count DESC LIMIT 15",
    )
    .all(params) as Array<{ country: string; count: number }>;
  return {
    period: { start: opts.periodStart, end },
    jobs: { total, by_work_mode: group("work_mode"), by_seniority: group("seniority"), by_employment_type: group("employment_type"), by_country: byCountry },
    top_skills: getSkillMarketDemand(db, { periodStart: opts.periodStart, periodEnd: end, limit: opts.topSkills ?? 30, compareWithPreviousPeriod: true }),
    compensation: getCompensationStatistics(db, { periodStart: opts.periodStart, periodEnd: end, currency: opts.currency ?? "USD", minSampleSize: opts.minSampleSize ?? 3 }),
    sources: getSourceStatistics(db, { since: opts.periodStart }),
    applications: getApplicationStatistics(db, { since: opts.periodStart }),
  };
}
