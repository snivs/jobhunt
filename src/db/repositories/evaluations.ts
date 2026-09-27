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
  state_hash: string | null;
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
    stateHash?: string | null;
    answers?: JevAnswers | null;
    error?: string | null;
  },
): JobEvaluationRow {
  const a = input.answers ?? null;
  const info = db
    .prepare(
      `INSERT INTO job_evaluations
         (job_id, run_id, profile_version, engine, question_set, answers_json, content_hash, state_hash,
          should_work_here, work_arrangement, relocation_required, skills_fit,
          hiring_requirements_met, technical_requirements_met, workable_from_mexico,
          six_day_week, support_only, primary_responsibility, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.jobId,
      input.runId ?? null,
      input.profileVersion,
      input.engine ?? "jev",
      input.questionSet,
      JSON.stringify(a?.raw ?? {}),
      input.contentHash ?? null,
      input.stateHash ?? null,
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
 * Cache identity is (job, state hash, question set), where the state hash digests the exact input
 * Jev is shown: the candidate profile, the structured analysis and the description excerpt. Showing
 * the model byte-identical state and byte-identical questions a second time buys nothing, and any
 * change to what it would see is a real reason to ask again - the employer edited the posting, the
 * candidate changed their preferences, the analyser improved, or we changed what we are asking.
 *
 * Failed rows are never served from cache, so a transient outage does not stick. An unknown state
 * hash is a miss rather than a hit: guessing that unknown input matches unknown input is how stale
 * answers survive.
 */
export function findCachedEvaluation(
  db: DB,
  opts: { jobId: number; stateHash: string | null; questionSet: string },
): JobEvaluationRow | null {
  if (!opts.stateHash) return null;
  return (db
    .prepare(
      `SELECT * FROM job_evaluations
        WHERE job_id = ? AND state_hash = ? AND question_set = ? AND error IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(opts.jobId, opts.stateHash, opts.questionSet) as JobEvaluationRow | undefined) ?? null;
}

export function getLatestJobEvaluation(db: DB, jobId: number): JobEvaluationRow | null {
  return (db
    .prepare("SELECT * FROM job_evaluations WHERE job_id = ? ORDER BY id DESC LIMIT 1")
    .get(jobId) as JobEvaluationRow | undefined) ?? null;
}

/**
 * Eligible, undecided postings, best score first: the pool the runner walks.
 *
 * This deliberately does NOT try to decide staleness. Whether an answer is still good depends on
 * the state hash, which digests the candidate profile, the structured analysis and the description,
 * and cannot be computed in SQL. The runner checks the cache per job and only spends a model call
 * on a real miss, so returning an already-answered posting here costs nothing.
 */
export function getJobsNeedingEvaluation(
  db: DB,
  opts: { minScore?: number; limit?: number } = {},
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
        ORDER BY score DESC
        LIMIT ?`,
    )
    .all(opts.minScore ?? 0, opts.limit ?? 200) as Array<{
    job_id: number;
    code: string;
    title: string;
    company_name: string | null;
  }>;
}
