import type { FactorScore, JobAnalysis, MatchResult } from "../../core/scoring.js";
import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";

export interface MatchRow {
  id: number;
  job_id: number;
  profile_version: number;
  scoring_version: string;
  overall_score: number;
  eligible: number;
  factors_json: string;
  strengths_json: string;
  risks_json: string;
  hard_constraint_failures_json: string;
  missing_information_json: string;
  analysis_json: string | null;
  run_id: number | null;
  scored_at: string;
  created_at: string;
}

export interface MatchView {
  id: number;
  job_id: number;
  profile_version: number;
  scoring_version: string;
  overall_score: number;
  eligible: boolean;
  factors: FactorScore[];
  strengths: string[];
  risks: string[];
  hard_constraint_failures: string[];
  missing_information: string[];
  analysis: JobAnalysis | null;
  run_id: number | null;
  scored_at: string;
}

export function toMatchView(r: MatchRow): MatchView {
  return {
    id: r.id,
    job_id: r.job_id,
    profile_version: r.profile_version,
    scoring_version: r.scoring_version,
    overall_score: r.overall_score,
    eligible: r.eligible === 1,
    factors: fromJson<FactorScore[]>(r.factors_json, []),
    strengths: fromJson<string[]>(r.strengths_json, []),
    risks: fromJson<string[]>(r.risks_json, []),
    hard_constraint_failures: fromJson<string[]>(r.hard_constraint_failures_json, []),
    missing_information: fromJson<string[]>(r.missing_information_json, []),
    analysis: fromJson<JobAnalysis | null>(r.analysis_json, null),
    run_id: r.run_id,
    scored_at: r.scored_at,
  };
}

/** Upsert on (job, profile_version, scoring_version): re-scoring the same job with the same inputs replaces the row. */
export function recordMatch(db: DB, input: { jobId: number; profileVersion: number; result: MatchResult; analysis: JobAnalysis | null; runId?: number | null }): MatchView {
  const now = nowIso();
  const r = input.result;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO job_matches (job_id, profile_version, scoring_version, overall_score, eligible, factors_json, strengths_json, risks_json,
         hard_constraint_failures_json, missing_information_json, analysis_json, run_id, scored_at, created_at)
       VALUES (@job_id, @profile_version, @scoring_version, @overall_score, @eligible, @factors, @strengths, @risks, @hcf, @missing, @analysis, @run_id, @now, @now)
       ON CONFLICT(job_id, profile_version, scoring_version) DO UPDATE SET overall_score = excluded.overall_score, eligible = excluded.eligible,
         factors_json = excluded.factors_json, strengths_json = excluded.strengths_json, risks_json = excluded.risks_json,
         hard_constraint_failures_json = excluded.hard_constraint_failures_json, missing_information_json = excluded.missing_information_json,
         analysis_json = excluded.analysis_json, run_id = excluded.run_id, scored_at = excluded.scored_at`,
    ).run({
      job_id: input.jobId,
      profile_version: input.profileVersion,
      scoring_version: r.scoringVersion,
      overall_score: r.overallScore,
      eligible: r.eligible ? 1 : 0,
      factors: toJson(r.factors),
      strengths: toJson(r.strengths),
      risks: toJson(r.risks),
      hcf: toJson(r.hardConstraintFailures),
      missing: toJson(r.missingInformation),
      analysis: input.analysis ? toJson(input.analysis) : null,
      run_id: input.runId ?? null,
      now,
    });
    return toMatchView(
      db.prepare("SELECT * FROM job_matches WHERE job_id = ? AND profile_version = ? AND scoring_version = ?").get(input.jobId, input.profileVersion, r.scoringVersion) as MatchRow,
    );
  });
  return tx();
}

export function getLatestMatch(db: DB, jobId: number): MatchView | null {
  const row = db.prepare("SELECT * FROM v_latest_job_matches WHERE job_id = ?").get(jobId) as MatchRow | undefined;
  return row ? toMatchView(row) : null;
}

export function getMatchHistory(db: DB, jobId: number): MatchView[] {
  return (db.prepare("SELECT * FROM job_matches WHERE job_id = ? ORDER BY scored_at DESC").all(jobId) as MatchRow[]).map(toMatchView);
}

export interface MatchingJobRow {
  job_id: number;
  title: string;
  company_name: string | null;
  company_id: number | null;
  location: string | null;
  country: string | null;
  work_mode: string;
  seniority: string;
  url: string;
  source_key: string;
  automation_policy: string;
  job_status: string;
  discovered_at: string;
  overall_score: number;
  eligible: number;
  scored_at: string;
  match_id: number;
  application_status: string | null;
  explicit_max_annual: number | null;
}

export function getMatchingJobs(
  db: DB,
  f: { minScore?: number; eligibleOnly?: boolean; sourceKey?: string; automationPolicy?: string; excludeApplied?: boolean; activeOnly?: boolean; limit?: number } = {},
): MatchingJobRow[] {
  const where: string[] = ["j.duplicate_of_job_id IS NULL"];
  const params: Record<string, unknown> = { limit: Math.min(f.limit ?? 50, 500) };
  if (f.activeOnly ?? true) where.push("j.status = 'active'");
  if (f.minScore != null) {
    where.push("m.overall_score >= @minScore");
    params.minScore = f.minScore;
  }
  if (f.eligibleOnly) where.push("m.eligible = 1");
  if (f.sourceKey) {
    where.push("s.key = @sourceKey");
    params.sourceKey = f.sourceKey;
  }
  if (f.automationPolicy) {
    where.push("s.automation_policy = @policy");
    params.policy = f.automationPolicy;
  }
  if (f.excludeApplied) {
    where.push(
      "(a.id IS NULL OR a.status IN ('DISCOVERED','MATCHED','SELECTED','PREPARING','READY','FAILED','SKIPPED','REQUIRES_USER_INPUT','BLOCKED'))",
    );
  }
  return db
    .prepare(
      `SELECT j.id AS job_id, j.title, j.company_name, j.company_id, j.location, j.country, j.work_mode, j.seniority, j.url, s.key AS source_key,
         s.automation_policy, j.status AS job_status, j.discovered_at, m.overall_score, m.eligible, m.scored_at, m.id AS match_id, a.status AS application_status,
         (SELECT MAX(CASE c.period WHEN 'year' THEN c.max_amount WHEN 'month' THEN c.max_amount * 12 WHEN 'week' THEN c.max_amount * 52 WHEN 'day' THEN c.max_amount * 260 WHEN 'hour' THEN c.max_amount * 2080 END)
            FROM compensation_observations c WHERE c.job_id = j.id AND c.observation_type = 'explicit') AS explicit_max_annual
       FROM v_latest_job_matches m
       JOIN jobs j ON j.id = m.job_id
       JOIN sources s ON s.id = j.source_id
       LEFT JOIN applications a ON a.job_id = j.id
       WHERE ${where.join(" AND ")}
       ORDER BY m.overall_score DESC, explicit_max_annual DESC NULLS LAST, j.discovered_at DESC
       LIMIT @limit`,
    )
    .all(params) as MatchingJobRow[];
}
