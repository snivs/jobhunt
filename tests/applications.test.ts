import { describe, expect, it } from "vitest";
import { ingestRawJob } from "../src/core/ingest.js";
import { scoreJob } from "../src/core/scoring.js";
import { canTransition } from "../src/core/state-machine.js";
import type { DB } from "../src/db/index.js";
import { assertCanSubmit, getApplication, getApplicationCandidates, getApplicationStatistics, getOrCreateApplication, transitionApplication, updateApplication } from "../src/db/repositories/applications.js";
import { recordMatch } from "../src/db/repositories/matches.js";
import { createRun } from "../src/db/repositories/runs.js";
import { rawJob, sampleAnalysis, sampleProfile, testConfig, testDb } from "./helpers.js";

const cfg = testConfig();
const scoringOptions = { weights: cfg.matching.weights, minimumScore: 80, undisclosedCompensationScore: 60, scoringVersion: "1.0" };

function scoredJob(db: DB, overrides: Parameters<typeof rawJob>[0] = {}, analysisOverrides: Parameters<typeof sampleAnalysis>[0] = {}) {
  const job = ingestRawJob(db, rawJob(overrides)).job;
  const result = scoreJob(sampleProfile(), sampleAnalysis({ jobId: job.id, ...analysisOverrides }), scoringOptions);
  recordMatch(db, { jobId: job.id, profileVersion: 1, result, analysis: null });
  return job;
}

function allowSource(db: DB, key: string): void {
  db.prepare("UPDATE sources SET automation_policy = 'apply_allowed' WHERE key = ?").run(key);
}

describe("application state machine and idempotency", () => {
  it("same application attempted twice -> one application", () => {
    const { db } = testDb();
    const job = scoredJob(db);
    const a = getOrCreateApplication(db, { jobId: job.id, initialStatus: "MATCHED" });
    const b = getOrCreateApplication(db, { jobId: job.id, initialStatus: "SELECTED" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.application.id).toBe(a.application.id);
    expect(b.application.status).toBe("MATCHED");
    expect(db.prepare("SELECT COUNT(*) AS c FROM applications").get()).toEqual({ c: 1 });
  });

  it("refuses applications to duplicate postings", () => {
    const { db } = testDb();
    ingestRawJob(db, rawJob());
    const dup = ingestRawJob(db, rawJob({ sourceKey: "remoteok", externalId: "x", url: "https://remoteok.com/1" }));
    expect(() => getOrCreateApplication(db, { jobId: dup.job.id })).toThrow(/duplicate/);
  });

  it("validates transitions and keeps an append-only history", () => {
    const { db } = testDb();
    const job = scoredJob(db);
    const app = getOrCreateApplication(db, { jobId: job.id, initialStatus: "MATCHED" }).application;
    expect(canTransition("MATCHED", "SUBMITTED")).toBe(false);
    expect(() => transitionApplication(db, { applicationId: app.id, to: "SUBMITTED", eventType: "x" })).toThrow(/Invalid application transition/);
    transitionApplication(db, { applicationId: app.id, to: "SELECTED", eventType: "selected" });
    transitionApplication(db, { applicationId: app.id, to: "PREPARING", eventType: "preparing" });
    transitionApplication(db, { applicationId: app.id, to: "READY", eventType: "prepared" });
    transitionApplication(db, { applicationId: app.id, to: "SUBMITTING", eventType: "submit_start" });
    const submitted = transitionApplication(db, { applicationId: app.id, to: "SUBMITTED", eventType: "submit_ok", externalReference: "ref-1" });
    expect(submitted.submitted_at).toBeTruthy();
    expect(submitted.external_reference).toBe("ref-1");
    // a retried confirmation is a no-op that still leaves a trace
    const again = transitionApplication(db, { applicationId: app.id, to: "SUBMITTED", eventType: "submit_ok" });
    expect(again.events.map((e) => e.to_status)).toEqual(["MATCHED", "SELECTED", "PREPARING", "READY", "SUBMITTING", "SUBMITTED", "SUBMITTED"]);
    expect(again.events.at(-1)?.event_type).toBe("submit_ok:repeat");
    // history rows are never modified
    expect(getApplication(db, app.id)!.events[0]!.to_status).toBe("MATCHED");
  });

  it("enforces the pre-flight checks and the per-source per-run limit", () => {
    const { db } = testDb();
    allowSource(db, "remotive");
    const run = createRun(db, { runKey: "test-run", trigger: "manual" }).run;
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const job = scoredJob(db, { externalId: `e${i}`, url: `https://remotive.com/${i}`, title: `Senior TypeScript Engineer ${i}` });
      const app = getOrCreateApplication(db, { jobId: job.id, runId: run.id, initialStatus: "SELECTED" }).application;
      updateApplication(db, app.id, { resume_variant: "backend" });
      transitionApplication(db, { applicationId: app.id, to: "PREPARING", eventType: "p", runId: run.id });
      transitionApplication(db, { applicationId: app.id, to: "READY", eventType: "r", runId: run.id });
      ids.push(app.id);
    }
    const base = { runId: run.id, maxPerSourcePerRun: 3, minimumScore: 80, automaticSubmission: true };
    for (const id of ids.slice(0, 3)) {
      const check = assertCanSubmit(db, { applicationId: id, ...base });
      expect(check.ok, check.reasons.join("; ")).toBe(true);
      transitionApplication(db, { applicationId: id, to: "SUBMITTING", eventType: "s", runId: run.id });
      transitionApplication(db, { applicationId: id, to: "SUBMITTED", eventType: "ok", runId: run.id });
    }
    const fourth = assertCanSubmit(db, { applicationId: ids[3]!, ...base });
    expect(fourth.ok).toBe(false);
    expect(fourth.reasons.join(" ")).toMatch(/Per-source limit reached/);
    // already submitted can never be submitted again
    const resubmit = assertCanSubmit(db, { applicationId: ids[0]!, ...base });
    expect(resubmit.ok).toBe(false);
    expect(resubmit.reasons.join(" ")).toMatch(/already SUBMITTED/);
    // disabled automatic submission blocks everything
    expect(assertCanSubmit(db, { applicationId: ids[3]!, ...base, automaticSubmission: false }).reasons.join(" ")).toMatch(/disabled/);
    // discover-only sources are never auto-submitted
    db.prepare("UPDATE sources SET automation_policy = 'discover_only' WHERE key = 'remotive'").run();
    expect(assertCanSubmit(db, { applicationId: ids[3]!, ...base }).reasons.join(" ")).toMatch(/policy is discover_only/);
  });

  it("lists candidates per source ordered by score with remaining quota", () => {
    const { db } = testDb();
    allowSource(db, "remotive");
    const run = createRun(db, { runKey: "run-2", trigger: "manual" }).run;
    scoredJob(db, { externalId: "a", url: "https://remotive.com/a", title: "Senior TypeScript Engineer A" });
    scoredJob(db, { externalId: "b", url: "https://remotive.com/b", title: "Senior TypeScript Engineer B" }, { skills: sampleAnalysis().skills.slice(0, 2) });
    scoredJob(db, { externalId: "c", url: "https://remotive.com/c", title: "Senior TypeScript Engineer C" }, { compensation: { min: 40000, max: 50000, currency: "USD", period: "year", explicit: true } });
    scoredJob(db, { sourceKey: "arbeitnow", externalId: "d", url: "https://arbeitnow.com/d", title: "Senior TypeScript Engineer D" });
    const groups = getApplicationCandidates(db, { runId: run.id, minimumScore: 80, maxPerSourcePerRun: 3 });
    expect(groups.map((g) => g.source_key)).toEqual(["remotive"]);
    expect(groups[0]!.quota_remaining).toBe(3);
    expect(groups[0]!.candidates.map((c) => c.title).sort()).toEqual(["Senior TypeScript Engineer A", "Senior TypeScript Engineer B"]); // C fails hard constraint
    expect(groups[0]!.candidates[0]!.overall_score).toBeGreaterThanOrEqual(groups[0]!.candidates[1]!.overall_score);
    const withManual = getApplicationCandidates(db, { runId: run.id, minimumScore: 80, maxPerSourcePerRun: 3, includeDiscoverOnly: true });
    expect(withManual.map((g) => g.source_key).sort()).toEqual(["arbeitnow", "remotive"]);
    const stats = getApplicationStatistics(db);
    expect(stats.funnel.discovered).toBe(4);
    expect(stats.funnel.relevant).toBe(3);
  });
});
