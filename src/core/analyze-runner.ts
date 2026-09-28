import type { LoadedConfig } from "../config/index.js";
import type { DB } from "../db/index.js";
import { recordMatch } from "../db/repositories/matches.js";
import { buildScoringProfile } from "../db/repositories/profile.js";
import { recordJobSkill } from "../db/repositories/skills.js";
import { analyzeJobRules, type JobForAnalysis } from "./analyze.js";
import { scoringOptionsFromConfig } from "./rescore.js";
import { scoreJob, type JobAnalysis } from "./scoring.js";

export interface AnalyzeRunSummary {
  profile_version: number;
  analyzed: number;
  eligible: number;
  skipped_no_description: number;
  remaining: number;
}

/** How much to trust a pattern match, by how firmly the posting asked for the skill. */
const RULE_CONFIDENCE: Record<JobAnalysis["skills"][number]["mentionType"], number> = {
  explicit_required: 0.7,
  explicit_preferred: 0.6,
  mentioned: 0.4,
  expected: 0.3,
};

interface PendingRow extends JobForAnalysis {
  min_amount: number | null;
  max_amount: number | null;
  currency: string | null;
  period: string | null;
  source_id: number;
  description_hash: string | null;
}

interface CopyRow extends JobForAnalysis {
  code: string | null;
  url: string;
}

function compensationOf(row: PendingRow): JobAnalysis["compensation"] {
  return row.min_amount != null || row.max_amount != null
    ? {
        min: row.min_amount,
        max: row.max_amount,
        currency: row.currency,
        period: (row.period ?? null) as NonNullable<JobAnalysis["compensation"]>["period"],
        explicit: true,
      }
    : null;
}

/**
 * When the canonical posting is rejected, reads the employer's own per-country copies whose text
 * differs and returns the best one that passes. Deduplication groups copies by company and title,
 * which is right for counting but wrong for eligibility: the copies can differ in a requirement,
 * not just in the place. Text similarity cannot tell those apart (Cognition's two LATAM copies
 * differ by one word, "Portuguese" against "Spanish"), so each copy is scored on its own text.
 */
function bestEligibleCopy(
  db: DB,
  row: PendingRow,
  canonical: { failures: string[] },
  score: (job: JobForAnalysis) => { analysis: JobAnalysis; scored: ReturnType<typeof scoreJob> },
): { analysis: JobAnalysis; scored: ReturnType<typeof scoreJob> } | null {
  const copies = db
    .prepare(
      `SELECT d.id, d.code, d.url, d.title, d.description, d.seniority, d.work_mode, d.country, d.remote_scope,
              d.employment_type, d.location
         FROM jobs d
        WHERE d.duplicate_of_job_id = @id AND d.source_id = @source AND d.status = 'active'
          AND d.description IS NOT NULL AND length(trim(d.description)) >= 80
          AND COALESCE(d.description_hash, '') <> COALESCE(@hash, '')`,
    )
    .all({ id: row.id, source: row.source_id, hash: row.description_hash }) as CopyRow[];

  let best: { analysis: JobAnalysis; scored: ReturnType<typeof scoreJob> } | null = null;
  for (const copy of copies) {
    const r = score(copy);
    if (!r.scored.eligible) continue;
    if (!best || r.scored.overallScore > best.scored.overallScore) {
      r.analysis.scoredCopy = { jobId: copy.id, code: copy.code, location: copy.location, url: copy.url, canonicalFailures: canonical.failures };
      r.analysis.bodyNotes = [
        ...(r.analysis.bodyNotes ?? []),
        `scored from the employer's ${copy.location ?? "other"} copy (${copy.code ?? copy.id}, ${copy.url}); the canonical ${row.location ?? ""} copy was rejected: ${canonical.failures.join("; ")}`,
      ];
      best = r;
    }
  }
  return best;
}

/**
 * Rule-analyses and scores every posting that has no analysis yet.
 *
 * This is the first pass over a backlog, not a replacement for reading a posting. Every analysis it
 * writes carries `rule-extracted: not read by an agent` in `missingInformation`, so nothing
 * downstream can mistake it for a careful read, and the scorer renormalizes its weights over the
 * factors that could actually be determined.
 *
 * What it buys: the corpus becomes rankable. Hard constraints can reject what is out of reach, Jev
 * can ask its ten questions of what survives, and the agent's reading time goes to the top of a
 * sorted list instead of to whichever posting happened to arrive first.
 */
export function runRuleAnalysis(
  db: DB,
  config: LoadedConfig,
  opts: { runId?: number | null; limit?: number; force?: boolean } = {},
): AnalyzeRunSummary {
  const profile = buildScoringProfile(db);
  if (!profile) throw new Error("No candidate profile: run the interview first");
  const options = scoringOptionsFromConfig(config);

  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.description, j.seniority, j.work_mode, j.country, j.remote_scope,
              j.employment_type, j.location, j.source_id, j.description_hash,
              -- The employer's own per-country copies of this posting (same source only: an
              -- aggregator's "Anywhere" copy must not widen what the employer itself restricted).
              (SELECT group_concat(COALESCE(d.location, '') || COALESCE(' / ' || d.country, ''), char(10))
                 FROM jobs d WHERE d.duplicate_of_job_id = j.id AND d.source_id = j.source_id) AS alt_locations,
              c.min_amount, c.max_amount, c.currency, c.period
         FROM jobs j
         LEFT JOIN (
           SELECT job_id, min_amount, max_amount, currency, period
             FROM compensation_observations
            WHERE observation_type = 'explicit'
            GROUP BY job_id
         ) c ON c.job_id = j.id
        WHERE j.status = 'active'
          AND j.duplicate_of_job_id IS NULL
          AND (
                NOT EXISTS (SELECT 1 FROM job_matches m WHERE m.job_id = j.id)
                -- force re-reads what rules produced, never what an agent read: a careful read
                -- must not be overwritten by a pattern match just because the patterns improved.
                OR (@force = 1 AND (SELECT m.analysis_json FROM job_matches m WHERE m.job_id = j.id ORDER BY m.id DESC LIMIT 1)
                                   LIKE '%rule-extracted%')
              )
        ORDER BY j.discovered_at DESC
        LIMIT @limit`,
    )
    .all({ force: opts.force ? 1 : 0, limit: opts.limit ?? 100 }) as PendingRow[];

  const summary: AnalyzeRunSummary = {
    profile_version: profile.version,
    analyzed: 0,
    eligible: 0,
    skipped_no_description: 0,
    remaining: 0,
  };

  for (const row of rows) {
    if (!row.description || row.description.trim().length < 80) {
      // Nothing to extract from. Left unanalysed rather than scored on a guess.
      summary.skipped_no_description++;
      continue;
    }

    const compensation = compensationOf(row);
    const analysis = analyzeJobRules(db, row, compensation, profile.practiceKeywords ?? []);

    for (const s of analysis.skills) {
      recordJobSkill(db, {
        jobId: row.id,
        skillName: s.name,
        mentionType: s.mentionType,
        // Lower than an agent read on purpose: a pattern match on a section heading is weaker
        // evidence than someone understanding the sentence it sits in.
        confidence: RULE_CONFIDENCE[s.mentionType],
        evidence: "rule extraction",
      });
    }

    let scored = scoreJob(profile, analysis, options);
    let recorded = analysis;
    if (!scored.eligible) {
      const copy = bestEligibleCopy(db, row, { failures: scored.hardConstraintFailures }, (job) => {
        // A copy is read on its own: its own place, no alternates. Identical copies never get here
        // (same text hash), so the alternates above already covered them.
        const a = analyzeJobRules(db, { ...job, alt_locations: null }, compensation, profile.practiceKeywords ?? []);
        return { analysis: a, scored: scoreJob(profile, a, options) };
      });
      if (copy) {
        scored = copy.scored;
        recorded = copy.analysis;
      }
    }
    recordMatch(db, {
      jobId: row.id,
      profileVersion: profile.version,
      result: scored,
      analysis: recorded,
      runId: opts.runId ?? null,
    });

    summary.analyzed++;
    if (scored.eligible) summary.eligible++;
  }

  summary.remaining = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs j
          WHERE j.status = 'active' AND j.duplicate_of_job_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM job_matches m WHERE m.job_id = j.id)`,
      )
      .get() as { c: number }
  ).c;

  return summary;
}
