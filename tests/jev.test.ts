import { describe, expect, it } from "vitest";
import { buildQuestions, buildState, jevModel, QUESTION_SET, RESPONSIBILITIES, stateHash, WORK_ARRANGEMENTS } from "../src/core/jev.js";
import { findCachedEvaluation, getJobsNeedingEvaluation, getLatestJobEvaluation, recordJobEvaluation } from "../src/db/repositories/evaluations.js";
import { runEvaluations } from "../src/core/evaluation-runner.js";
import { buildScoringProfile, upsertProfile } from "../src/db/repositories/profile.js";
import { sampleAnalysis, sampleProfile, testDb } from "./helpers.js";

describe("jev relevance questions", () => {
  it("asks exactly the ten questions, typed so a posting cannot invent its own answer", () => {
    const q = buildQuestions();
    expect(Object.keys(q)).toEqual([
      "shouldWorkHere",
      "workArrangement",
      "relocationRequired",
      "skillsFit",
      "hiringRequirementsMet",
      "technicalRequirementsMet",
      "workableFromMexico",
      "sixDayWeek",
      "supportOnly",
      "primaryResponsibility",
    ]);
    // Every answer is a bounded type: booleans carry a probability, choices a closed option set.
    for (const [key, question] of Object.entries(q)) {
      expect(["boolean", "choice", "score"], key).toContain(question.type);
      if (question.type === "choice") expect(Object.keys(question.criteria ?? {}).length, key).toBeGreaterThan(1);
    }
    expect(Object.keys(q.workArrangement.criteria ?? {})).toEqual(Object.keys(WORK_ARRANGEMENTS));
    expect(Object.keys(q.primaryResponsibility.criteria ?? {})).toEqual(Object.keys(RESPONSIBILITIES));
  });

  it("puts the posting's prose in the state as data, stripped and bounded", () => {
    const html = `<p>We need <b>TypeScript</b>.</p>${"x".repeat(9000)}`;
    const state = buildState(sampleProfile(), sampleAnalysis(), html);
    const excerpt = state.posting.descriptionExcerpt;
    expect(excerpt).not.toContain("<");
    expect(excerpt.length).toBeLessThanOrEqual(4000);
    // Tags become spaces, so punctuation may end up spaced; harmless for the evaluator.
    expect(excerpt.startsWith("We need TypeScript")).toBe(true);
    expect(excerpt).not.toMatch(/\s{2,}/);
  });

  it("carries the candidate facts the questions are judged against", () => {
    const state = buildState(sampleProfile(), sampleAnalysis(), null);
    expect(state.candidate.livesIn).toBe("Chihuahua, Mexico");
    expect(state.candidate.willRelocate).toBe(false);
    expect(state.candidate.skills.map((s) => s.name)).toContain("TypeScript");
    expect(state.candidate.compensationFloor?.minimum).toBe(80000);
    // Required vs preferred is the distinction questions 4 and 6 turn on.
    expect(state.posting.requiredSkills).toContain("TypeScript");
    expect(state.posting.preferredSkills).toContain("AWS");
  });

  it("refuses to build a model without credentials instead of failing silently at call time", () => {
    expect(() => jevModel({} as NodeJS.ProcessEnv)).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });
});

describe("job evaluation storage", () => {
  const answers = {
    shouldWorkHere: 0.51,
    workArrangement: "remote" as const,
    relocationRequired: 0.12,
    skillsFit: 0.87,
    hiringRequirementsMet: 0.63,
    technicalRequirementsMet: 0.89,
    workableFromMexico: 0.77,
    sixDayWeek: 0.1,
    supportOnly: 0.02,
    primaryResponsibility: "technical_leadership" as const,
    raw: { shouldWorkHere: { type: "boolean", probability: 0.51 } },
  };

  function seedJob(db: ReturnType<typeof testDb>["db"]) {
    db.prepare(
      "INSERT INTO jobs (id, source_id, url, title, normalized_title, description_hash, content_hash, dedup_key, discovered_at, last_seen_at, status, created_at, updated_at, code) VALUES (1,1,'https://x/1','Tech Lead','tech lead','h','h','k','2026-09-01','2026-09-01','active','2026-09-01','2026-09-01','VAC-1.1')",
    ).run();
  }

  it("keeps every evaluation instead of overwriting, so a flipped answer stays visible", () => {
    const { db } = testDb();
    seedJob(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 1, questionSet: QUESTION_SET, answers });
    recordJobEvaluation(db, { jobId: 1, profileVersion: 2, questionSet: QUESTION_SET, answers: { ...answers, shouldWorkHere: 0.2 } });

    const count = db.prepare("SELECT COUNT(*) c FROM job_evaluations WHERE job_id = 1").get() as { c: number };
    expect(count.c).toBe(2);
    expect(getLatestJobEvaluation(db, 1)?.should_work_here).toBe(0.2);
  });

  it("records a failure rather than skipping the job silently", () => {
    const { db } = testDb();
    seedJob(db);
    const row = recordJobEvaluation(db, { jobId: 1, profileVersion: 1, questionSet: QUESTION_SET, error: "Cloudflare: HTTP 429" });
    expect(row.error).toMatch(/429/);
    expect(row.should_work_here).toBeNull();
  });

  it("lists eligible undecided postings and leaves staleness to the cache", () => {
    const { db } = testDb();
    seedJob(db);
    db.prepare(
      "INSERT INTO job_matches (job_id, profile_version, scoring_version, overall_score, eligible, factors_json, strengths_json, risks_json, hard_constraint_failures_json, missing_information_json, scored_at, created_at) VALUES (1,5,'1.0',88,1,'[]','[]','[]','[]','[]','2026-09-01','2026-09-01')",
    ).run();
    const pending = () => getJobsNeedingEvaluation(db).map((r) => r.job_id);
    expect(pending()).toEqual([1]);

    // A job scored under several profile versions keeps one job_matches row per version. Joining
    // them would multiply the job into duplicates, and every duplicate is a paid model call.
    db.prepare(
      "INSERT INTO job_matches (job_id, profile_version, scoring_version, overall_score, eligible, factors_json, strengths_json, risks_json, hard_constraint_failures_json, missing_information_json, scored_at, created_at) VALUES (1,4,'1.0',90,1,'[]','[]','[]','[]','[]','2026-09-02','2026-09-02')",
    ).run();
    db.prepare(
      "INSERT INTO applications (job_id, source_id, status, idempotency_key, created_at, updated_at) VALUES (1,1,'MATCHED','k1','2026-09-01','2026-09-01')",
    ).run();
    expect(pending(), "one row per job, never one per match version").toEqual([1]);

    // A decided application takes the job out of the pool entirely.
    db.prepare("UPDATE applications SET status='SKIPPED' WHERE job_id=1").run();
    expect(pending(), "decided jobs are not re-evaluated").toEqual([]);
  });
});

describe("evaluation cache", () => {
  const answers = {
    shouldWorkHere: 0.51,
    workArrangement: "remote" as const,
    relocationRequired: 0.12,
    skillsFit: 0.87,
    hiringRequirementsMet: 0.63,
    technicalRequirementsMet: 0.89,
    workableFromMexico: 0.77,
    sixDayWeek: 0.1,
    supportOnly: 0.02,
    primaryResponsibility: "technical_leadership" as const,
    raw: {},
  };

  function seed(db: ReturnType<typeof testDb>["db"], contentHash = "hash-v1") {
    db.prepare(
      `INSERT INTO jobs (id, source_id, url, title, normalized_title, description_hash, content_hash, dedup_key,
                         discovered_at, last_seen_at, status, created_at, updated_at, code)
       VALUES (1,1,'https://x/1','Tech Lead','tech lead','d',?,'k','2026-09-01','2026-09-01','active','2026-09-01','2026-09-01','VAC-1.1')`,
    ).run(contentHash);
    db.prepare(
      "INSERT INTO job_matches (job_id, profile_version, scoring_version, overall_score, eligible, factors_json, strengths_json, risks_json, hard_constraint_failures_json, missing_information_json, scored_at, created_at) VALUES (1,5,'1.0',88,1,'[]','[]','[]','[]','[]','2026-09-01','2026-09-01')",
    ).run();
  }

  const key = { jobId: 1, stateHash: "state-v1", questionSet: QUESTION_SET };

  it("serves an identical question about an identical posting from storage", () => {
    const { db } = testDb();
    seed(db);
    expect(findCachedEvaluation(db, key)).toBeNull();
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", stateHash: "state-v1", answers });
    expect(findCachedEvaluation(db, key)?.should_work_here).toBe(0.51);
  });

  it("misses when anything Jev would see changed", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", stateHash: "state-v1", answers });

    // The state hash digests the candidate profile, the analysis and the description at once, so
    // an edited posting, a changed profile and an improved analyser are all one kind of miss.
    expect(findCachedEvaluation(db, { ...key, stateHash: "state-v2" }), "the input changed").toBeNull();
    expect(findCachedEvaluation(db, { ...key, questionSet: "v2" }), "we changed the questions").toBeNull();
    expect(findCachedEvaluation(db, { ...key, jobId: 2 }), "different posting").toBeNull();
  });

  it("derives the same state hash for the same input and a different one when the analysis changes", () => {
    const base = stateHash(sampleProfile(), sampleAnalysis(), "text");
    expect(stateHash(sampleProfile(), sampleAnalysis(), "text")).toBe(base);
    expect(stateHash(sampleProfile(), sampleAnalysis({ skills: [] }), "text"), "analysis changed").not.toBe(base);
    expect(stateHash(sampleProfile({ relocation: true }), sampleAnalysis(), "text"), "profile changed").not.toBe(base);
    expect(stateHash(sampleProfile(), sampleAnalysis(), "other text"), "posting edited").not.toBe(base);
  });

  it("never serves a failed call from cache, so an outage does not stick", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", stateHash: "state-v1", error: "Cloudflare: HTTP 503" });
    expect(findCachedEvaluation(db, key)).toBeNull();
  });

  it("treats an unknown state as a miss rather than assuming it matches", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, stateHash: null, answers });
    expect(findCachedEvaluation(db, { ...key, stateHash: null })).toBeNull();
  });

  it("a posting the analyser or the employer changed is a cache miss, so it gets asked again", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", stateHash: "state-v1", answers });

    expect(findCachedEvaluation(db, key), "nothing changed").not.toBeNull();
    expect(findCachedEvaluation(db, { ...key, stateHash: "state-v2" }), "input changed").toBeNull();
  });

  it("runEvaluations reports a cache hit without calling the model", async () => {
    const { db } = testDb();
    seed(db);
    const profile = upsertProfile(db, { full_name: "Test" });

    // The runner keys the cache on the state it would actually send, so the stored row must carry
    // the hash of that same state: profile + stored analysis + description.
    const analysis = sampleAnalysis({ jobId: 1 });
    db.prepare("UPDATE job_matches SET analysis_json = ? WHERE job_id = 1").run(JSON.stringify(analysis));
    const scoringProfile = buildScoringProfile(db)!;
    const hash = stateHash(scoringProfile, analysis, null);
    recordJobEvaluation(db, {
      jobId: 1,
      profileVersion: profile.version,
      questionSet: QUESTION_SET,
      contentHash: "hash-v1",
      stateHash: hash,
      answers,
    });

    // No credentials are set, so any real call would throw. A clean result proves nothing was sent.
    const summary = await runEvaluations(db, { jobIds: [1], env: {} as NodeJS.ProcessEnv });
    expect(summary.cached).toBe(1);
    expect(summary.evaluated).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({ job_id: 1, cached: true });
    expect(summary.results[0].answers?.shouldWorkHere).toBe(0.51);
  });
});
