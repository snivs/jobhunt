import type { DB } from "../db/index.js";
import { getJob } from "../db/repositories/jobs.js";
import { getLatestMatch } from "../db/repositories/matches.js";
import { buildScoringProfile, getProfileRow } from "../db/repositories/profile.js";
import { findCachedEvaluation, getJobsNeedingEvaluation, recordJobEvaluation, type JobEvaluationRow } from "../db/repositories/evaluations.js";
import { evaluateJob, QUESTION_SET, stateHash, type JevAnswers } from "./jev.js";
import type { JobAnalysis } from "./scoring.js";

export interface EvaluationSummary {
  profile_version: number;
  question_set: string;
  evaluated: number;
  /** Served from a previous answer about identical input; no model call was made. */
  cached: number;
  failed: number;
  skipped_no_analysis: number;
  results: Array<{ job_id: number; code: string; title: string; company: string | null; cached?: boolean; answers?: JevAnswers; error?: string }>;
}

/** Rebuilds the typed answers from a stored row, so a cache hit looks like a fresh evaluation. */
function rowToAnswers(row: JobEvaluationRow): JevAnswers {
  return {
    shouldWorkHere: row.should_work_here ?? 0,
    workArrangement: (row.work_arrangement ?? "unclear") as JevAnswers["workArrangement"],
    relocationRequired: row.relocation_required ?? 0,
    skillsFit: row.skills_fit ?? 0,
    hiringRequirementsMet: row.hiring_requirements_met ?? 0,
    technicalRequirementsMet: row.technical_requirements_met ?? 0,
    workableFromMexico: row.workable_from_mexico ?? 0,
    sixDayWeek: row.six_day_week ?? 0,
    supportOnly: row.support_only ?? 0,
    primaryResponsibility: (row.primary_responsibility ?? "other") as JevAnswers["primaryResponsibility"],
    raw: JSON.parse(row.answers_json || "{}") as Record<string, unknown>,
  };
}

/**
 * Runs the ten relevance questions over eligible, undecided postings that lack a current answer.
 *
 * This runs BEFORE a posting is proposed to the candidate, which is the whole point: the candidate
 * sees Jev's read next to the deterministic score, not instead of it. Nothing here changes
 * `job_matches`, eligibility, or any application state. A posting Jev dislikes still surfaces; a
 * posting Jev likes is still rejected if a hard constraint says so.
 *
 * One failure never stops the batch: it is recorded on the row and retried next time.
 */
export async function runEvaluations(
  db: DB,
  opts: {
    runId?: number | null;
    limit?: number;
    minScore?: number;
    env?: NodeJS.ProcessEnv;
    jobIds?: number[];
    /** Ask again even when a cached answer exists. For deliberate re-asks, not routine runs. */
    force?: boolean;
  } = {},
): Promise<EvaluationSummary> {
  const profileRow = getProfileRow(db);
  const profile = buildScoringProfile(db);
  if (!profileRow || !profile) throw new Error("No candidate profile: run the interview before evaluating jobs");

  const targets = opts.jobIds?.length
    ? opts.jobIds.map((id) => {
        const j = getJob(db, id);
        return { job_id: id, code: j?.code ?? String(id), title: j?.title ?? "", company_name: j?.company_name ?? null };
      })
    // A generous pool: `limit` below caps MODEL CALLS, not candidates, so cache hits do not eat
    // the budget and a run can serve many answers while paying for few.
    : getJobsNeedingEvaluation(db, { minScore: opts.minScore, limit: (opts.limit ?? 25) * 10 });

  const summary: EvaluationSummary = {
    profile_version: profileRow.version,
    question_set: QUESTION_SET,
    evaluated: 0,
    cached: 0,
    failed: 0,
    skipped_no_analysis: 0,
    results: [],
  };

  const callBudget = opts.limit ?? 25;

  for (const t of targets) {
    if (summary.evaluated + summary.failed >= callBudget) break;
    const job = getJob(db, t.job_id);
    const contentHash = job?.content_hash ?? null;
    const analysis: JobAnalysis | null = getLatestMatch(db, t.job_id)?.analysis ?? null;
    if (!analysis) {
      // Jev reasons over the structured analysis; without it there is nothing to ask about, and
      // nothing to key a cache lookup on either.
      summary.skipped_no_analysis++;
      continue;
    }
    const hash = stateHash(profile, analysis, job?.description ?? null);

    // Checked on every path, including an explicit job_ids request, so asking about the same
    // posting twice costs nothing. `force` is the way to mean it.
    if (!opts.force) {
      const hit = findCachedEvaluation(db, { jobId: t.job_id, stateHash: hash, questionSet: QUESTION_SET });
      if (hit) {
        summary.cached++;
        summary.results.push({
          job_id: t.job_id,
          code: t.code,
          title: t.title,
          company: t.company_name,
          cached: true,
          answers: rowToAnswers(hit),
        });
        continue;
      }
    }

    try {
      const answers = await evaluateJob(profile, analysis, job?.description ?? null, opts.env);
      recordJobEvaluation(db, {
        jobId: t.job_id,
        runId: opts.runId ?? null,
        profileVersion: profileRow.version,
        questionSet: QUESTION_SET,
        contentHash,
        stateHash: hash,
        answers,
      });
      summary.evaluated++;
      summary.results.push({ job_id: t.job_id, code: t.code, title: t.title, company: t.company_name, answers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordJobEvaluation(db, {
        jobId: t.job_id,
        runId: opts.runId ?? null,
        profileVersion: profileRow.version,
        questionSet: QUESTION_SET,
        contentHash,
        stateHash: hash,
        error: message,
      });
      summary.failed++;
      summary.results.push({ job_id: t.job_id, code: t.code, title: t.title, company: t.company_name, error: message });
    }
  }

  return summary;
}
