import type { LoadedConfig } from "../config/index.js";
import type { DB } from "../db/index.js";
import { fromJson } from "../db/index.js";
import { recordMatch } from "../db/repositories/matches.js";
import { buildScoringProfile } from "../db/repositories/profile.js";
import { scoreJob, type JobAnalysis, type ScoringOptions } from "./scoring.js";

export function scoringOptionsFromConfig(config: LoadedConfig): ScoringOptions {
  return {
    weights: config.matching.weights,
    minimumScore: config.matching.minimum_score,
    undisclosedCompensationScore: config.matching.undisclosed_compensation_score,
    scoringVersion: config.matching.scoring_version,
    fxRates: config.matching.fx_rates,
  };
}

export interface RescoreResult {
  profile_version: number;
  scoring_version: string;
  rescored: number;
  skipped_no_analysis: number;
  eligible_after: number;
  changes: Array<{ job_id: number; title: string; before: number; after: number; eligible: boolean }>;
}

/**
 * Re-scores every active canonical job whose latest match has a stored analysis but no match for
 * the current profile version / scoring version (profile edits, weight changes, fx updates).
 * Never re-reads postings: the stored structured analysis is the input.
 */
export function rescorePending(db: DB, config: LoadedConfig, opts: { runId?: number | null; limit?: number } = {}): RescoreResult {
  const profile = buildScoringProfile(db);
  if (!profile) throw new Error("No candidate profile: run the interview first");
  const options = scoringOptionsFromConfig(config);
  const rows = db
    .prepare(
      `SELECT j.id AS job_id, j.title, m.analysis_json, m.overall_score
       FROM v_latest_job_matches m
       JOIN jobs j ON j.id = m.job_id
       WHERE j.status = 'active' AND j.duplicate_of_job_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM job_matches x WHERE x.job_id = j.id AND x.profile_version = @pv AND x.scoring_version = @sv)
       ORDER BY m.overall_score DESC
       LIMIT @limit`,
    )
    .all({ pv: profile.version, sv: options.scoringVersion, limit: opts.limit ?? 1000 }) as Array<{ job_id: number; title: string; analysis_json: string | null; overall_score: number }>;
  const result: RescoreResult = { profile_version: profile.version, scoring_version: options.scoringVersion, rescored: 0, skipped_no_analysis: 0, eligible_after: 0, changes: [] };
  for (const row of rows) {
    const analysis = fromJson<JobAnalysis | null>(row.analysis_json, null);
    if (!analysis) {
      result.skipped_no_analysis++;
      continue;
    }
    const scored = scoreJob(profile, analysis, options);
    recordMatch(db, { jobId: row.job_id, profileVersion: profile.version, result: scored, analysis, runId: opts.runId ?? null });
    result.rescored++;
    if (scored.eligible) result.eligible_after++;
    result.changes.push({ job_id: row.job_id, title: row.title, before: row.overall_score, after: scored.overallScore, eligible: scored.eligible });
  }
  return result;
}
