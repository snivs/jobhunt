import { describe, expect, it } from "vitest";
import { buildQuestions, buildState, jevModel, QUESTION_SET, RESPONSIBILITIES, WORK_ARRANGEMENTS } from "../src/core/jev.js";
import { findCachedEvaluation, getJobsNeedingEvaluation, getLatestJobEvaluation, recordJobEvaluation } from "../src/db/repositories/evaluations.js";
import { runEvaluations } from "../src/core/evaluation-runner.js";
import { upsertProfile } from "../src/db/repositories/profile.js";
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

  it("treats an evaluation from another profile version or question set as stale", () => {
    const { db } = testDb();
    seedJob(db);
    db.prepare(
      "INSERT INTO job_matches (job_id, profile_version, scoring_version, overall_score, eligible, factors_json, strengths_json, risks_json, hard_constraint_failures_json, missing_information_json, scored_at, created_at) VALUES (1,5,'1.0',88,1,'[]','[]','[]','[]','[]','2026-09-01','2026-09-01')",
    ).run();

    const pending = () => getJobsNeedingEvaluation(db, { profileVersion: 5, questionSet: QUESTION_SET }).map((r) => r.job_id);
    expect(pending()).toEqual([1]);

    // A job scored under several profile versions keeps one job_matches row per version. Joining
    // them multiplies the job into duplicates, and every duplicate is a paid model call on a
    // posting already evaluated in the same batch.
    db.prepare(
      "INSERT INTO job_matches (job_id, profile_version, scoring_version, overall_score, eligible, factors_json, strengths_json, risks_json, hard_constraint_failures_json, missing_information_json, scored_at, created_at) VALUES (1,4,'1.0',90,1,'[]','[]','[]','[]','[]','2026-09-02','2026-09-02')",
    ).run();
    db.prepare(
      "INSERT INTO applications (job_id, source_id, status, idempotency_key, created_at, updated_at) VALUES (1,1,'MATCHED','k1','2026-09-01','2026-09-01')",
    ).run();
    expect(pending(), "one row per job, never one per match version").toEqual([1]);

    // A decided application takes the job out of the queue entirely.
    db.prepare("UPDATE applications SET status='SKIPPED' WHERE job_id=1").run();
    expect(pending(), "decided jobs are not re-evaluated").toEqual([]);
    db.prepare("UPDATE applications SET status='MATCHED' WHERE job_id=1").run();

    recordJobEvaluation(db, { jobId: 1, profileVersion: 4, questionSet: QUESTION_SET, contentHash: "h", answers });
    expect(pending(), "older profile version is stale").toEqual([1]);

    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: "something-else", contentHash: "h", answers });
    expect(pending(), "different question set is stale").toEqual([1]);

    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "h", error: "boom" });
    expect(pending(), "a failed evaluation is retried").toEqual([1]);

    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "h", answers });
    expect(pending(), "a current answer clears it").toEqual([]);
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

  const key = { jobId: 1, contentHash: "hash-v1", profileVersion: 5, questionSet: QUESTION_SET };

  it("serves an identical question about an identical posting from storage", () => {
    const { db } = testDb();
    seed(db);
    expect(findCachedEvaluation(db, key)).toBeNull();
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", answers });
    expect(findCachedEvaluation(db, key)?.should_work_here).toBe(0.51);
  });

  it("misses when any part of the cache identity changed", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", answers });

    expect(findCachedEvaluation(db, { ...key, contentHash: "hash-v2" }), "employer edited the posting").toBeNull();
    expect(findCachedEvaluation(db, { ...key, profileVersion: 6 }), "candidate changed their profile").toBeNull();
    expect(findCachedEvaluation(db, { ...key, questionSet: "v2" }), "we changed the questions").toBeNull();
    expect(findCachedEvaluation(db, { ...key, jobId: 2 }), "different posting").toBeNull();
  });

  it("never serves a failed call from cache, so an outage does not stick", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", error: "Cloudflare: HTTP 503" });
    expect(findCachedEvaluation(db, key)).toBeNull();
  });

  it("treats unknown content as a miss rather than assuming it matches", () => {
    const { db } = testDb();
    seed(db);
    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: null, answers });
    expect(findCachedEvaluation(db, { ...key, contentHash: null })).toBeNull();
  });

  it("re-queues a posting the employer edited, and only then", () => {
    const { db } = testDb();
    seed(db);
    const pending = () => getJobsNeedingEvaluation(db, { profileVersion: 5, questionSet: QUESTION_SET }).map((r) => r.job_id);

    recordJobEvaluation(db, { jobId: 1, profileVersion: 5, questionSet: QUESTION_SET, contentHash: "hash-v1", answers });
    expect(pending(), "unchanged posting stays out of the queue").toEqual([]);

    db.prepare("UPDATE jobs SET content_hash = 'hash-v2' WHERE id = 1").run();
    expect(pending(), "edited posting comes back").toEqual([1]);
  });

  it("runEvaluations reports a cache hit without calling the model", async () => {
    const { db } = testDb();
    seed(db);
    const profile = upsertProfile(db, { full_name: "Test" });
    recordJobEvaluation(db, { jobId: 1, profileVersion: profile.version, questionSet: QUESTION_SET, contentHash: "hash-v1", answers });

    // No credentials are set, so any real call would throw. A clean result proves nothing was sent.
    const summary = await runEvaluations(db, { jobIds: [1], env: {} as NodeJS.ProcessEnv });
    expect(summary.cached).toBe(1);
    expect(summary.evaluated).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({ job_id: 1, cached: true });
    expect(summary.results[0].answers?.shouldWorkHere).toBe(0.51);
  });
});
