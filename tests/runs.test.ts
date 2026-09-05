import { describe, expect, it } from "vitest";
import { ingestRawJob } from "../src/core/ingest.js";
import { acquireLock, getLock, heartbeatLock, PIPELINE_LOCK, releaseLock } from "../src/core/lock.js";
import { finishPipelineRun, getScheduleStatus, recoverInterruptedRuns, startPipelineRun, STATE_LAST_COMPLETED_SLOT } from "../src/core/run-manager.js";
import { getApplication, getOrCreateApplication, transitionApplication } from "../src/db/repositories/applications.js";
import { completeRun, createRun, getRun, getState, recordRunError, recordSourceResult, updateRunStats } from "../src/db/repositories/runs.js";
import { requireSource } from "../src/db/repositories/sources.js";
import { rawJob, testDb } from "./helpers.js";

// Friday 2026-09-04 13:30 America/Chihuahua = 19:30 UTC (Chihuahua is UTC-6 year-round since 2022)
const FRIDAY_1330 = new Date("2026-09-04T19:30:00Z");

describe("runs, locks and recovery", () => {
  it("createRun is idempotent by run_key and accumulates stats", () => {
    const { db } = testDb();
    const a = createRun(db, { runKey: "2026-09-04T13:00", trigger: "scheduled" });
    const b = createRun(db, { runKey: "2026-09-04T13:00", trigger: "scheduled" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    updateRunStats(db, a.run.id, { jobs_discovered: 10, jobs_new: 3 });
    updateRunStats(db, a.run.id, { jobs_discovered: 5 });
    expect(getRun(db, a.run.id)!.stats.jobs_discovered).toBe(15);
    recordRunError(db, { runId: a.run.id, source: "remotive", operation: "fetch", error: "timeout", recoverable: true });
    recordSourceResult(db, { runId: a.run.id, sourceId: requireSource(db, "remotive").id, status: "failed", error: "timeout" });
    const done = completeRun(db, a.run.id, { status: "completed" });
    expect(done.status).toBe("completed");
    expect(done.stats.errors).toBe(1);
    expect(done.errors).toHaveLength(1);
  });

  it("lock: second holder is refused until release or expiry; heartbeat extends", () => {
    const { db } = testDb();
    expect(acquireLock(db, PIPELINE_LOCK, "A", 30).acquired).toBe(true);
    const second = acquireLock(db, PIPELINE_LOCK, "B", 30);
    expect(second.acquired).toBe(false);
    expect(second.reason).toMatch(/held by A/);
    expect(heartbeatLock(db, PIPELINE_LOCK, "A", 30)).toBe(true);
    expect(heartbeatLock(db, PIPELINE_LOCK, "B", 30)).toBe(false);
    expect(releaseLock(db, PIPELINE_LOCK, "B")).toBe(false);
    expect(releaseLock(db, PIPELINE_LOCK, "A")).toBe(true);
    expect(acquireLock(db, PIPELINE_LOCK, "B", 30).acquired).toBe(true);
    // expired lock can be taken over
    db.prepare("UPDATE run_locks SET expires_at = '2000-01-01T00:00:00Z'").run();
    const takeover = acquireLock(db, PIPELINE_LOCK, "C", 30);
    expect(takeover.acquired).toBe(true);
    expect(takeover.tookOver?.holder).toBe("B");
    expect(getLock(db, PIPELINE_LOCK)?.holder).toBe("C");
  });

  it("starts a scheduled run only when a slot is due and skips overlapping runs", () => {
    const { db, config } = testDb();
    const started = startPipelineRun(db, config, { trigger: "loop", holder: "S1", now: FRIDAY_1330 });
    expect(started.status).toBe("started");
    expect(started.run_key).toBe("2026-09-04T13:00");
    // the same slot while running -> skipped and recorded
    const overlap = startPipelineRun(db, config, { trigger: "loop", holder: "S2", now: new Date(FRIDAY_1330.getTime() + 60_000) });
    expect(overlap.status).toBe("skipped");
    expect(overlap.reason).toMatch(/Overlapping/);
    expect(overlap.run?.status).toBe("skipped");
    finishPipelineRun(db, { runId: started.run!.id, holder: "S1", status: "completed", stats: { jobs_new: 1 } });
    expect(getState(db, STATE_LAST_COMPLETED_SLOT, null)).toBe("2026-09-04T13:00");
    expect(getLock(db, PIPELINE_LOCK)).toBeNull();
    // same slot again -> nothing due
    const again = startPipelineRun(db, config, { trigger: "loop", holder: "S1", now: new Date(FRIDAY_1330.getTime() + 120_000) });
    expect(again.status).toBe("skipped");
    expect(again.reason).toMatch(/No scheduled slot due|already completed/);
    // manual trigger always runs
    const manual = startPipelineRun(db, config, { trigger: "manual", holder: "S1", now: FRIDAY_1330 });
    expect(manual.status).toBe("started");
    expect(manual.run_key.startsWith("manual:")).toBe(true);
    // weekend: nothing due
    finishPipelineRun(db, { runId: manual.run!.id, holder: "S1", status: "completed" });
    const saturday = startPipelineRun(db, config, { trigger: "loop", holder: "S1", now: new Date("2026-09-05T19:30:00Z") });
    expect(saturday.status).toBe("skipped");
    expect(getScheduleStatus(db, config, new Date("2026-09-05T19:30:00Z")).next_slot).toBe("2026-09-07T07:00");
  });

  it("recovers an interrupted run: SUBMITTING -> REQUIRES_USER_INPUT, PREPARING -> FAILED, run -> interrupted", () => {
    const { db, config } = testDb();
    const crashed = startPipelineRun(db, config, { trigger: "manual", holder: "OLD", now: FRIDAY_1330 });
    const runId = crashed.run!.id;
    const j1 = ingestRawJob(db, rawJob({ externalId: "1", url: "https://remotive.com/1" })).job;
    const j2 = ingestRawJob(db, rawJob({ externalId: "2", url: "https://remotive.com/2", title: "Other" })).job;
    const a1 = getOrCreateApplication(db, { jobId: j1.id, runId, initialStatus: "SELECTED" }).application;
    const a2 = getOrCreateApplication(db, { jobId: j2.id, runId, initialStatus: "SELECTED" }).application;
    for (const a of [a1, a2]) transitionApplication(db, { applicationId: a.id, to: "PREPARING", eventType: "p", runId });
    transitionApplication(db, { applicationId: a1.id, to: "READY", eventType: "r", runId });
    transitionApplication(db, { applicationId: a1.id, to: "SUBMITTING", eventType: "s", runId });
    // simulate crash: lock expired, run still 'running'
    db.prepare("UPDATE run_locks SET expires_at = '2000-01-01T00:00:00Z'").run();
    const next = startPipelineRun(db, config, { trigger: "manual", holder: "NEW", now: new Date(FRIDAY_1330.getTime() + 3_600_000) });
    expect(next.status).toBe("started");
    expect(next.recovered.map((r) => r.action).sort()).toEqual(["marked_interrupted", "preparing_to_failed", "submitting_to_requires_user_input"]);
    expect(getRun(db, runId)!.status).toBe("interrupted");
    expect(getApplication(db, a1.id)!.status).toBe("REQUIRES_USER_INPUT");
    expect(getApplication(db, a2.id)!.status).toBe("FAILED");
    expect(getApplication(db, a1.id)!.events.at(-1)!.event_type).toBe("recovery_interrupted_submission");
    // idempotent: nothing left to recover
    expect(recoverInterruptedRuns(db, { exceptRunId: next.run!.id })).toEqual([]);
  });
});
