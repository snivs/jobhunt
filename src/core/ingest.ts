import type { DB } from "../db/index.js";
import { recordCompensation, type PayPeriod } from "../db/repositories/compensation.js";
import { upsertJob, type UpsertJobResult } from "../db/repositories/jobs.js";
import { normalizeJob, type RawJob } from "./normalize.js";

export interface IngestResult extends UpsertJobResult {
  compensation_recorded: boolean;
}

const PERIODS: PayPeriod[] = ["hour", "day", "week", "month", "year"];

function normalizePeriod(p: string | null | undefined): PayPeriod {
  const v = (p ?? "year").toLowerCase();
  if (v.startsWith("hour")) return "hour";
  if (v.startsWith("da")) return "day";
  if (v.startsWith("week")) return "week";
  if (v.startsWith("month")) return "month";
  if (v.startsWith("year") || v.startsWith("annual") || v === "yr") return "year";
  return PERIODS.includes(v as PayPeriod) ? (v as PayPeriod) : "year";
}

/**
 * Normalizes a raw posting, upserts it (idempotent) and records the published salary range,
 * if any, as an EXPLICIT compensation observation sourced from the posting itself.
 */
export function ingestRawJob(db: DB, raw: RawJob, opts: { runId?: number | null } = {}): IngestResult {
  const normalized = normalizeJob(raw);
  const result = upsertJob(db, normalized, { runId: opts.runId ?? null });
  let compensationRecorded = false;
  const salary = normalized.salary;
  if (salary && (salary.min != null || salary.max != null) && salary.currency && !result.job.duplicate_of_job_id) {
    const rec = recordCompensation(db, {
      jobId: result.job.id,
      companyId: result.job.company_id,
      observationType: "explicit",
      minAmount: salary.min ?? null,
      maxAmount: salary.max ?? null,
      currency: salary.currency,
      period: normalizePeriod(salary.period),
      source: "job_posting",
      confidence: 1,
      evidence: salary.text ?? null,
      role: normalized.title,
      seniority: normalized.seniority,
      location: normalized.location,
      observedAt: normalized.postedAt ?? undefined,
    });
    compensationRecorded = rec.created;
  }
  return { ...result, compensation_recorded: compensationRecorded };
}
