import type { EmploymentType, NormalizedJob, Seniority, WorkMode } from "../../core/normalize.js";
import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";
import { upsertCompany } from "./companies.js";
import { requireSource } from "./sources.js";

export type JobStatus = "active" | "expired" | "closed" | "filled" | "unknown";

export interface JobRow {
  id: number;
  source_id: number;
  external_id: string | null;
  url: string;
  canonical_url: string | null;
  title: string;
  normalized_title: string;
  company_id: number | null;
  company_name: string | null;
  location: string | null;
  country: string | null;
  work_mode: WorkMode;
  remote_scope: string | null;
  description: string | null;
  description_hash: string | null;
  content_hash: string;
  dedup_key: string;
  posted_at: string | null;
  discovered_at: string;
  last_seen_at: string;
  last_verified_at: string | null;
  status: JobStatus;
  seniority: Seniority;
  employment_type: EmploymentType;
  language: string | null;
  raw_metadata_json: string | null;
  duplicate_of_job_id: number | null;
  /** search run whose discovery stage first stored the job (null when ingested outside a run) */
  discovered_run_id: number | null;
  /** short human identifier VAC-<discovery run>.<job id>, e.g. VAC-2.119 */
  code: string;
  created_at: string;
  updated_at: string;
}

export const JOB_CODE_RE = /^VAC-(\d+)\.(\d+)$/i;

/** Builds the short identifier for a job: VAC-<run>.<id> (run 0 when the job was ingested outside a run). */
export function buildJobCode(runId: number | null | undefined, jobId: number): string {
  return `VAC-${runId ?? 0}.${jobId}`;
}

/** Parses "VAC-2.119" (case-insensitive, surrounding whitespace ignored) into its job id, or null. */
export function parseJobCode(code: string): { runId: number; jobId: number } | null {
  const m = JOB_CODE_RE.exec(code.trim());
  return m ? { runId: Number(m[1]), jobId: Number(m[2]) } : null;
}

export type UpsertOutcome = "created" | "updated" | "unchanged" | "duplicate";

export interface UpsertJobResult {
  job: JobRow;
  outcome: UpsertOutcome;
  /** set when the posting duplicates a job already known from another source/URL */
  duplicateOfJobId: number | null;
}

function snapshotOf(j: NormalizedJob): Record<string, unknown> {
  return {
    title: j.title,
    company: j.companyName,
    location: j.location,
    country: j.country,
    workMode: j.workMode,
    remoteScope: j.remoteScope,
    seniority: j.seniority,
    employmentType: j.employmentType,
    postedAt: j.postedAt,
    salary: j.salary,
    descriptionHash: j.descriptionHash,
    descriptionLength: j.description?.length ?? 0,
  };
}

/**
 * Idempotent insert/update of a normalized job.
 * Identity within a source: (source_id, external_id) or (source_id, canonical_url).
 * Cross-source identity: dedup_key (company + title) or canonical_url; the newer posting is kept as a
 * record but flagged duplicate_of_job_id so statistics and scoring see a single job.
 */
export function upsertJob(db: DB, job: NormalizedJob, opts: { now?: string; runId?: number | null } = {}): UpsertJobResult {
  const now = opts.now ?? nowIso();
  const runId = opts.runId ?? null;
  const source = requireSource(db, job.sourceKey);
  const tx = db.transaction((): UpsertJobResult => {
    let existing: JobRow | undefined;
    if (job.externalId) {
      existing = db.prepare("SELECT * FROM jobs WHERE source_id = ? AND external_id = ?").get(source.id, job.externalId) as JobRow | undefined;
    }
    if (!existing) {
      existing = db.prepare("SELECT * FROM jobs WHERE source_id = ? AND canonical_url = ?").get(source.id, job.canonicalUrl) as JobRow | undefined;
    }
    const companyId = job.companyName ? upsertCompany(db, { name: job.companyName }).company.id : null;

    if (existing) {
      if (existing.content_hash === job.contentHash) {
        db.prepare("UPDATE jobs SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.id);
        return { job: getJob(db, existing.id)!, outcome: "unchanged", duplicateOfJobId: existing.duplicate_of_job_id };
      }
      db.prepare(
        `UPDATE jobs SET url = @url, canonical_url = @canonical_url, title = @title, normalized_title = @normalized_title,
           company_id = COALESCE(@company_id, company_id), company_name = COALESCE(@company_name, company_name),
           location = @location, country = COALESCE(@country, country), work_mode = @work_mode, remote_scope = COALESCE(@remote_scope, remote_scope),
           description = COALESCE(@description, description), description_hash = COALESCE(@description_hash, description_hash),
           content_hash = @content_hash, dedup_key = @dedup_key, posted_at = COALESCE(@posted_at, posted_at),
           last_seen_at = @now, seniority = @seniority, employment_type = @employment_type, language = COALESCE(@language, language),
           raw_metadata_json = COALESCE(@raw_metadata_json, raw_metadata_json), status = 'active', updated_at = @now
         WHERE id = @id`,
      ).run({
        id: existing.id,
        url: job.url,
        canonical_url: job.canonicalUrl,
        title: job.title,
        normalized_title: job.normalizedTitle,
        company_id: companyId,
        company_name: job.companyName,
        location: job.location,
        country: job.country,
        work_mode: job.workMode,
        remote_scope: job.remoteScope,
        description: job.description,
        description_hash: job.descriptionHash,
        content_hash: job.contentHash,
        dedup_key: job.dedupKey,
        posted_at: job.postedAt,
        now,
        seniority: job.seniority,
        employment_type: job.employmentType,
        language: job.language,
        raw_metadata_json: job.rawMetadata ? toJson(job.rawMetadata) : null,
      });
      db.prepare("INSERT INTO job_versions (job_id, content_hash, snapshot_json, observed_at) VALUES (?, ?, ?, ?)").run(
        existing.id,
        job.contentHash,
        toJson(snapshotOf(job)),
        now,
      );
      return { job: getJob(db, existing.id)!, outcome: "updated", duplicateOfJobId: existing.duplicate_of_job_id };
    }

    // Cross-source duplicate detection: same canonical URL or same dedup key on an active, canonical job.
    const dup = db
      .prepare(
        `SELECT id FROM jobs WHERE duplicate_of_job_id IS NULL AND status = 'active'
           AND (canonical_url = ? OR dedup_key = ?) ORDER BY discovered_at ASC LIMIT 1`,
      )
      .get(job.canonicalUrl, job.dedupKey) as { id: number } | undefined;

    const res = db
      .prepare(
        `INSERT INTO jobs (source_id, external_id, url, canonical_url, title, normalized_title, company_id, company_name, location, country,
           work_mode, remote_scope, description, description_hash, content_hash, dedup_key, posted_at, discovered_at, last_seen_at,
           status, seniority, employment_type, language, raw_metadata_json, duplicate_of_job_id, discovered_run_id, created_at, updated_at)
         VALUES (@source_id, @external_id, @url, @canonical_url, @title, @normalized_title, @company_id, @company_name, @location, @country,
           @work_mode, @remote_scope, @description, @description_hash, @content_hash, @dedup_key, @posted_at, @now, @now,
           'active', @seniority, @employment_type, @language, @raw_metadata_json, @duplicate_of_job_id, @discovered_run_id, @now, @now)`,
      )
      .run({
        source_id: source.id,
        external_id: job.externalId,
        url: job.url,
        canonical_url: job.canonicalUrl,
        title: job.title,
        normalized_title: job.normalizedTitle,
        company_id: companyId,
        company_name: job.companyName,
        location: job.location,
        country: job.country,
        work_mode: job.workMode,
        remote_scope: job.remoteScope,
        description: job.description,
        description_hash: job.descriptionHash,
        content_hash: job.contentHash,
        dedup_key: job.dedupKey,
        posted_at: job.postedAt,
        now,
        seniority: job.seniority,
        employment_type: job.employmentType,
        language: job.language,
        raw_metadata_json: job.rawMetadata ? toJson(job.rawMetadata) : null,
        duplicate_of_job_id: dup?.id ?? null,
        discovered_run_id: runId,
      });
    const id = Number(res.lastInsertRowid);
    db.prepare("UPDATE jobs SET code = ? WHERE id = ?").run(buildJobCode(runId, id), id);
    db.prepare("INSERT INTO job_versions (job_id, content_hash, snapshot_json, observed_at) VALUES (?, ?, ?, ?)").run(id, job.contentHash, toJson(snapshotOf(job)), now);
    return { job: getJob(db, id)!, outcome: dup ? "duplicate" : "created", duplicateOfJobId: dup?.id ?? null };
  });
  return tx();
}

export function getJob(db: DB, id: number): JobRow | null {
  return (db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
}

export function getJobByCode(db: DB, code: string): JobRow | null {
  return (db.prepare("SELECT * FROM jobs WHERE code = ?").get(code.trim().toUpperCase()) as JobRow | undefined) ?? null;
}

/**
 * Resolves a job reference given as a numeric id, a numeric string or a short code ("VAC-2.119").
 * Returns null when nothing matches.
 */
export function resolveJob(db: DB, ref: number | string): JobRow | null {
  if (typeof ref === "number") return getJob(db, ref);
  const t = ref.trim();
  if (/^\d+$/.test(t)) return getJob(db, Number(t));
  return getJobByCode(db, t);
}

export interface JobPatch {
  status?: JobStatus;
  seniority?: Seniority;
  work_mode?: WorkMode;
  employment_type?: EmploymentType;
  country?: string | null;
  remote_scope?: string | null;
  language?: string | null;
  company_id?: number | null;
  description?: string | null;
  last_verified_at?: string | null;
  posted_at?: string | null;
}

const PATCHABLE: Array<keyof JobPatch> = [
  "status", "seniority", "work_mode", "employment_type", "country", "remote_scope", "language", "company_id", "description", "last_verified_at", "posted_at",
];

export function updateJob(db: DB, id: number, patch: JobPatch): JobRow {
  const existing = getJob(db, id);
  if (!existing) throw new Error(`Job ${id} not found`);
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: nowIso() };
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  if (sets.length === 0) return existing;
  db.prepare(`UPDATE jobs SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`).run(params);
  return getJob(db, id)!;
}

export interface JobSearchFilters {
  query?: string;
  status?: JobStatus | "any";
  sourceKey?: string;
  workMode?: WorkMode;
  seniority?: Seniority;
  companyId?: number;
  discoveredAfter?: string;
  minScore?: number;
  eligibleOnly?: boolean;
  includeDuplicates?: boolean;
  unscoredOnly?: boolean;
  profileVersion?: number;
  scoringVersion?: string;
  limit?: number;
  offset?: number;
}

export interface JobSearchRow extends JobRow {
  source_key: string;
  automation_policy: string;
  overall_score: number | null;
  eligible: number | null;
  application_status: string | null;
}

export function searchJobs(db: DB, f: JobSearchFilters = {}): JobSearchRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!f.includeDuplicates) where.push("j.duplicate_of_job_id IS NULL");
  if (f.status && f.status !== "any") {
    where.push("j.status = @status");
    params.status = f.status;
  } else if (!f.status) {
    where.push("j.status = 'active'");
  }
  if (f.sourceKey) {
    where.push("s.key = @sourceKey");
    params.sourceKey = f.sourceKey;
  }
  if (f.workMode) {
    where.push("j.work_mode = @workMode");
    params.workMode = f.workMode;
  }
  if (f.seniority) {
    where.push("j.seniority = @seniority");
    params.seniority = f.seniority;
  }
  if (f.companyId) {
    where.push("j.company_id = @companyId");
    params.companyId = f.companyId;
  }
  if (f.discoveredAfter) {
    where.push("j.discovered_at >= @discoveredAfter");
    params.discoveredAfter = f.discoveredAfter;
  }
  if (f.query) {
    where.push("(j.normalized_title LIKE @q OR lower(j.company_name) LIKE @q OR lower(j.description) LIKE @q OR lower(j.location) LIKE @q)");
    params.q = `%${f.query.toLowerCase()}%`;
  }
  if (f.minScore != null) {
    where.push("m.overall_score >= @minScore");
    params.minScore = f.minScore;
  }
  if (f.eligibleOnly) where.push("m.eligible = 1");
  if (f.unscoredOnly) {
    if (f.profileVersion != null && f.scoringVersion) {
      where.push(
        "NOT EXISTS (SELECT 1 FROM job_matches jm WHERE jm.job_id = j.id AND jm.profile_version = @profileVersion AND jm.scoring_version = @scoringVersion)",
      );
      params.profileVersion = f.profileVersion;
      params.scoringVersion = f.scoringVersion;
    } else {
      where.push("m.id IS NULL");
    }
  }
  const sql = `
    SELECT j.*, s.key AS source_key, s.automation_policy, m.overall_score, m.eligible, a.status AS application_status
    FROM jobs j
    JOIN sources s ON s.id = j.source_id
    LEFT JOIN v_latest_job_matches m ON m.job_id = j.id
    LEFT JOIN applications a ON a.job_id = j.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY COALESCE(m.overall_score, -1) DESC, j.discovered_at DESC
    LIMIT @limit OFFSET @offset`;
  params.limit = Math.min(f.limit ?? 50, 500);
  params.offset = f.offset ?? 0;
  return db.prepare(sql).all(params) as JobSearchRow[];
}

export function getJobVersions(db: DB, jobId: number): Array<{ id: number; content_hash: string; snapshot: Record<string, unknown>; observed_at: string }> {
  const rows = db.prepare("SELECT id, content_hash, snapshot_json, observed_at FROM job_versions WHERE job_id = ? ORDER BY observed_at").all(jobId) as Array<{
    id: number;
    content_hash: string;
    snapshot_json: string;
    observed_at: string;
  }>;
  return rows.map((r) => ({ id: r.id, content_hash: r.content_hash, snapshot: fromJson(r.snapshot_json, {}), observed_at: r.observed_at }));
}

/** Marks jobs from a source that have not been seen for N days as expired (never deletes). */
export function expireStaleJobs(db: DB, opts: { sourceId?: number; notSeenForDays: number }): number {
  const cutoff = new Date(Date.now() - opts.notSeenForDays * 86_400_000).toISOString();
  const now = nowIso();
  const res = opts.sourceId
    ? db.prepare("UPDATE jobs SET status = 'expired', updated_at = ? WHERE status = 'active' AND source_id = ? AND last_seen_at < ?").run(now, opts.sourceId, cutoff)
    : db.prepare("UPDATE jobs SET status = 'expired', updated_at = ? WHERE status = 'active' AND last_seen_at < ?").run(now, cutoff);
  return res.changes;
}

export function countJobs(db: DB, opts: { since?: string; sourceId?: number } = {}): { total: number; canonical: number; duplicates: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.since) {
    where.push("discovered_at >= @since");
    params.since = opts.since;
  }
  if (opts.sourceId) {
    where.push("source_id = @sourceId");
    params.sourceId = opts.sourceId;
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN duplicate_of_job_id IS NULL THEN 1 ELSE 0 END) AS canonical FROM jobs ${w}`)
    .get(params) as { total: number; canonical: number | null };
  const canonical = row.canonical ?? 0;
  return { total: row.total, canonical, duplicates: row.total - canonical };
}
