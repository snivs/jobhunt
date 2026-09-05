import { toAnnual } from "../../core/scoring.js";
import { nowIso } from "../../core/time.js";
import type { DB } from "../index.js";

export type ObservationType = "explicit" | "expected";
export type PayPeriod = "hour" | "day" | "week" | "month" | "year";

export interface CompensationRow {
  id: number;
  job_id: number | null;
  company_id: number | null;
  observation_type: ObservationType;
  min_amount: number | null;
  max_amount: number | null;
  currency: string;
  period: PayPeriod;
  source: string;
  observed_at: string;
  confidence: number | null;
  methodology: string | null;
  evidence: string | null;
  equity: string | null;
  bonus: string | null;
  role: string | null;
  seniority: string | null;
  location: string | null;
  created_at: string;
}

export interface CompensationInput {
  jobId?: number | null;
  companyId?: number | null;
  observationType: ObservationType;
  minAmount?: number | null;
  maxAmount?: number | null;
  currency: string;
  period: PayPeriod;
  /** where the observation comes from: job_posting | agent_estimate | levels.fyi | glassdoor | user ... */
  source: string;
  observedAt?: string;
  confidence?: number | null;
  methodology?: string | null;
  evidence?: string | null;
  equity?: string | null;
  bonus?: string | null;
  role?: string | null;
  seniority?: string | null;
  location?: string | null;
}

/** Idempotent: an identical observation (same job/type/source/amounts) is not duplicated. */
export function recordCompensation(db: DB, input: CompensationInput): { observation: CompensationRow; created: boolean } {
  if (input.minAmount == null && input.maxAmount == null) throw new Error("At least one of minAmount/maxAmount is required");
  if (input.observationType === "expected" && (input.confidence == null || !input.methodology)) {
    throw new Error("Expected (estimated) compensation requires confidence and methodology");
  }
  if (input.confidence != null && (input.confidence < 0 || input.confidence > 1)) throw new Error("confidence must be between 0 and 1");
  const currency = input.currency.toUpperCase();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT * FROM compensation_observations WHERE observation_type = ? AND source = ? AND currency = ? AND period = ?
           AND job_id IS ? AND company_id IS ? AND min_amount IS ? AND max_amount IS ? LIMIT 1`,
      )
      .get(input.observationType, input.source, currency, input.period, input.jobId ?? null, input.companyId ?? null, input.minAmount ?? null, input.maxAmount ?? null) as
      | CompensationRow
      | undefined;
    if (existing) return { observation: existing, created: false };
    const now = nowIso();
    const res = db
      .prepare(
        `INSERT INTO compensation_observations (job_id, company_id, observation_type, min_amount, max_amount, currency, period, source, observed_at,
           confidence, methodology, evidence, equity, bonus, role, seniority, location, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId ?? null,
        input.companyId ?? null,
        input.observationType,
        input.minAmount ?? null,
        input.maxAmount ?? null,
        currency,
        input.period,
        input.source,
        input.observedAt ?? now,
        input.confidence ?? null,
        input.methodology ?? null,
        input.evidence ?? null,
        input.equity ?? null,
        input.bonus ?? null,
        input.role ?? null,
        input.seniority ?? null,
        input.location ?? null,
        now,
      );
    return { observation: db.prepare("SELECT * FROM compensation_observations WHERE id = ?").get(Number(res.lastInsertRowid)) as CompensationRow, created: true };
  });
  return tx();
}

export function getJobCompensation(db: DB, jobId: number): CompensationRow[] {
  return db.prepare("SELECT * FROM compensation_observations WHERE job_id = ? ORDER BY observation_type, observed_at DESC").all(jobId) as CompensationRow[];
}

export interface CompensationStatsFilters {
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  seniority?: string;
  role?: string;
  location?: string;
  workMode?: string;
  sourceKey?: string;
  minSampleSize?: number;
}

export interface CompensationStats {
  sample_size: number;
  currency: string;
  /** all values annualized */
  min: number | null;
  max: number | null;
  median_min: number | null;
  median_max: number | null;
  median_midpoint: number | null;
  p25_midpoint: number | null;
  p75_midpoint: number | null;
  mean_confidence: number | null;
  insufficient_sample: boolean;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return Math.round(a + (b - a) * (idx - lo));
}

function statsFor(rows: CompensationRow[], currency: string, minSample: number): CompensationStats {
  const mins: number[] = [];
  const maxs: number[] = [];
  const mids: number[] = [];
  const confs: number[] = [];
  for (const r of rows) {
    const mn = r.min_amount != null ? toAnnual(r.min_amount, r.period) : null;
    const mx = r.max_amount != null ? toAnnual(r.max_amount, r.period) : null;
    if (mn != null) mins.push(mn);
    if (mx != null) maxs.push(mx);
    const mid = mn != null && mx != null ? (mn + mx) / 2 : (mn ?? mx);
    if (mid != null) mids.push(mid);
    if (r.confidence != null) confs.push(r.confidence);
  }
  mins.sort((a, b) => a - b);
  maxs.sort((a, b) => a - b);
  mids.sort((a, b) => a - b);
  const insufficient = rows.length < minSample;
  return {
    sample_size: rows.length,
    currency,
    min: insufficient ? null : (mins[0] ?? mids[0] ?? null),
    max: insufficient ? null : (maxs[maxs.length - 1] ?? mids[mids.length - 1] ?? null),
    median_min: insufficient ? null : percentile(mins, 0.5),
    median_max: insufficient ? null : percentile(maxs, 0.5),
    median_midpoint: insufficient ? null : percentile(mids, 0.5),
    p25_midpoint: insufficient ? null : percentile(mids, 0.25),
    p75_midpoint: insufficient ? null : percentile(mids, 0.75),
    mean_confidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100 : null,
    insufficient_sample: insufficient,
  };
}

/**
 * Explicit (published) and expected (estimated) compensation are ALWAYS reported separately.
 * Only observations in the requested currency are aggregated (no FX conversion is attempted).
 */
export function getCompensationStatistics(db: DB, f: CompensationStatsFilters = {}): { filters: CompensationStatsFilters; explicit: CompensationStats; expected: CompensationStats } {
  const currency = (f.currency ?? "USD").toUpperCase();
  const where: string[] = ["c.currency = @currency"];
  const params: Record<string, unknown> = { currency };
  if (f.periodStart) {
    where.push("c.observed_at >= @periodStart");
    params.periodStart = f.periodStart;
  }
  if (f.periodEnd) {
    where.push("c.observed_at < @periodEnd");
    params.periodEnd = f.periodEnd;
  }
  if (f.seniority) {
    where.push("COALESCE(c.seniority, j.seniority) = @seniority");
    params.seniority = f.seniority;
  }
  if (f.role) {
    where.push("(lower(c.role) LIKE @role OR j.normalized_title LIKE @role)");
    params.role = `%${f.role.toLowerCase()}%`;
  }
  if (f.location) {
    where.push("(lower(c.location) LIKE @loc OR lower(j.location) LIKE @loc OR lower(j.country) LIKE @loc)");
    params.loc = `%${f.location.toLowerCase()}%`;
  }
  if (f.workMode) {
    where.push("j.work_mode = @workMode");
    params.workMode = f.workMode;
  }
  if (f.sourceKey) {
    where.push("s.key = @sourceKey");
    params.sourceKey = f.sourceKey;
  }
  const rows = db
    .prepare(
      `SELECT c.* FROM compensation_observations c
       LEFT JOIN jobs j ON j.id = c.job_id
       LEFT JOIN sources s ON s.id = j.source_id
       WHERE ${where.join(" AND ")} AND (j.id IS NULL OR j.duplicate_of_job_id IS NULL)`,
    )
    .all(params) as CompensationRow[];
  const minSample = f.minSampleSize ?? 3;
  return {
    filters: { ...f, currency },
    explicit: statsFor(rows.filter((r) => r.observation_type === "explicit"), currency, minSample),
    expected: statsFor(rows.filter((r) => r.observation_type === "expected"), currency, minSample),
  };
}
