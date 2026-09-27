import { type DB } from "../index.js";
import { nowIso } from "../../core/time.js";
import type { JevAnswers } from "../../core/jev.js";

export interface JobEvaluationRow {
  id: number;
  job_id: number;
  run_id: number | null;
  profile_version: number;
  engine: string;
  question_set: string;
  answers_json: string;
  content_hash: string | null;
  should_work_here: number | null;
  work_arrangement: string | null;
  relocation_required: number | null;
  skills_fit: number | null;
  hiring_requirements_met: number | null;
  technical_requirements_met: number | null;
  workable_from_mexico: number | null;
  six_day_week: number | null;
  support_only: number | null;
  primary_responsibility: string | null;
  error: string | null;
  created_at: string;
}

/**
 * Append-only: a re-evaluation inserts a new row. Keeping the old answer visible matters because
 * these are probabilistic judgements, and an answer that flips after a profile change is a signal
 * worth reading rather than a value to overwrite.
 */
export function recordJobEvaluation(
  db: DB,
  input: {
    jobId: number;
    runId?: number | null;
    profileVersion: number;
    questionSet: string;
    engine?: string;
    contentHash?: string | null;
    answers?: JevAnswers | null;
    error?: string | null;
  },
): JobEvaluationRow {
  const a = input.answers ?? null;
  const info = db
    .prepare(
      `INSERT INTO job_evaluations
         (job_id, run_id, profile_version, engine, question_set, answers_json, content_hash,
          should_work_here, work_arrangement, relocation_required, skills_fit,
          hiring_requirements_met, technical_requirements_met, workable_from_mexico,
          six_day_week, support_only, primary_responsibility, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.jobId,
      input.runId ?? null,
      input.profileVersion,
      input.engine ?? "jev",
      input.questionSet,
      JSON.stringify(a?.raw ?? {}),
      input.contentHash ?? null,
      a?.shouldWorkHere ?? null,
      a?.workArrangement ?? null,
      a?.relocationRequired ?? null,
      a?.skillsFit ?? null,
      a?.hiringRequirementsMet ?? null,
      a?.technicalRequirementsMet ?? null,
      a?.workableFromMexico ?? null,
      a?.sixDayWeek ?? null,
      a?.supportOnly ?? null,
      a?.primaryResponsibility ?? null,
      input.error ?? null,
      nowIso(),
    );
  return db.prepare("SELECT * FROM job_evaluations WHERE id = ?").get(info.lastInsertRowid) as JobEvaluationRow;
}


/**
 * The cache. Returns the newest successful answer for this exact combination, or null.
 *
 * Cache identity is (job, posting content, candidate profile version, question set). Jev is
 * deterministic in its inputs but not free: showing it byte-identical state and byte-identical
 * questions a second time buys nothing. Any of the four changing is a real reason to ask again -
 * the employer edited the posting, the candidate changed their preferences, or we changed what we
 * are asking. Failed rows are never served from cache, so a transient outage does not stick.
 *
 * A posting whose `content_hash` is unknown (NULL on either side) is treated as a miss rather than
 * a hit: guessing that unknown content matches unknown content is how stale answers survive.
 */
export function findCachedEvaluation(
  db: DB,
  opts: { jobId: number; contentHash: string | null; profileVersion: number; questionSet: string },
): JobEvaluationRow | null {
  if (!opts.contentHash) return null;
  return (db
    .prepare(
      `SELECT * FROM job_evaluations
        WHERE job_id = ? AND content_hash = ? AND profile_version = ? AND question_set = ?
          AND error IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(opts.jobId, opts.contentHash, opts.profileVersion, opts.questionSet) as JobEvaluationRow | undefined) ?? null;
}

export function getLatestJobEvaluation(db: DB, jobId: number): JobEvaluationRow | null {
  return (db
    .prepare("SELECT * FROM job_evaluations WHERE job_id = ? ORDER BY id DESC LIMIT 1")
    .get(jobId) as JobEvaluationRow | undefined) ?? null;
}

/**
 * Eligible, undecided postings that have no current Jev evaluation. "Current" means same profile
 * version and same question set: a profile change or a question change makes an old answer stale.
 * Failed evaluations are retried, so a transient Cloudflare error does not permanently skip a job.
 */
export function getJobsNeedingEvaluation(
  db: DB,
  opts: { profileVersion: number; questionSet: string; minScore?: number; limit?: number },
): Array<{ job_id: number; code: string; title: string; company_name: string | null }> {
  // Correlated subqueries rather than joins: a job can carry several job_matches rows and several
  // applications, and joining them multiplies the job into duplicates. That is not cosmetic here -
  // each duplicate is a paid model call on a posting already evaluated in the same batch.
  return db
    .prepare(
      `SELECT j.id AS job_id, j.code, j.title, j.company_name,
              (SELECT m.overall_score FROM job_matches m WHERE m.job_id = j.id ORDER BY m.id DESC LIMIT 1) AS score
         FROM jobs j
        WHERE j.status = 'active'
          AND (SELECT m.eligible FROM job_matches m WHERE m.job_id = j.id ORDER BY m.id DESC LIMIT 1) = 1
          AND COALESCE((SELECT m.overall_score FROM job_matches m WHERE m.job_id = j.id ORDER BY m.id DESC LIMIT 1), 0) >= ?
          AND NOT EXISTS (
            SELECT 1 FROM applications a
             WHERE a.job_id = j.id
               AND a.status NOT IN ('DISCOVERED','MATCHED')
          )
          AND NOT EXISTS (
            SELECT 1 FROM job_evaluations e
             WHERE e.job_id = j.id
               AND e.profile_version = ?
               AND e.question_set = ?
               AND e.error IS NULL
               -- A posting edited since we asked is a cache miss, so it is queued again.
               AND (e.content_hash IS NOT NULL AND e.content_hash = j.content_hash)
          )
        ORDER BY score DESC
        LIMIT ?`,
    )
    .all(opts.minScore ?? 0, opts.profileVersion, opts.questionSet, opts.limit ?? 25) as Array<{
    job_id: number;
    code: string;
    title: string;
    company_name: string | null;
  }>;
}
