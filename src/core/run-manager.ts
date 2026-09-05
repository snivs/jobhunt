import type { LoadedConfig } from "../config/index.js";
import type { DB } from "../db/index.js";
import { listApplications, transitionApplication } from "../db/repositories/applications.js";
import { completeRun, createRun, getRun, getState, listRuns, recordRunError, setState, type RunStats, type RunTrigger, type RunView } from "../db/repositories/runs.js";
import { acquireLock, getLock, heartbeatLock, isLockExpired, PIPELINE_LOCK, releaseLock, type LockRecord } from "./lock.js";
import { dueSlot, nextSlot, nowIso, previousSlot } from "./time.js";

export const STATE_LAST_COMPLETED_SLOT = "last_completed_slot";

export interface RecoveryAction {
  run_id: number;
  run_key: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface StartResult {
  status: "started" | "skipped";
  run: RunView | null;
  run_key: string;
  reason?: string;
  recovered: RecoveryAction[];
  lock: LockRecord | null;
}

/**
 * Recovers runs left in 'running' state by a crash: marks them interrupted and puts their
 * in-flight applications into safe states. Never resubmits anything.
 */
export function recoverInterruptedRuns(db: DB, opts: { exceptRunId?: number | null } = {}): RecoveryAction[] {
  const actions: RecoveryAction[] = [];
  const running = listRuns(db, { status: "running", limit: 50 }).filter((r) => r.id !== opts.exceptRunId);
  for (const run of running) {
    const tx = db.transaction(() => {
      // Applications mid-submission: outcome unknown, a human must verify before any retry.
      for (const app of listApplications(db, { status: "SUBMITTING", runId: run.id, limit: 500 })) {
        transitionApplication(db, {
          applicationId: app.id,
          to: "REQUIRES_USER_INPUT",
          eventType: "recovery_interrupted_submission",
          details: { reason: "Run interrupted while submitting; verify whether the application went through before retrying", interrupted_run_id: run.id },
          runId: run.id,
        });
        actions.push({ run_id: run.id, run_key: run.run_key, action: "submitting_to_requires_user_input", details: { application_id: app.id } });
      }
      // Applications mid-preparation: safe to fail and rebuild later.
      for (const app of listApplications(db, { status: "PREPARING", runId: run.id, limit: 500 })) {
        transitionApplication(db, {
          applicationId: app.id,
          to: "FAILED",
          eventType: "recovery_interrupted_preparation",
          details: { reason: "Run interrupted during preparation; recoverable", interrupted_run_id: run.id },
          failureReason: "interrupted during preparation",
          runId: run.id,
        });
        actions.push({ run_id: run.id, run_key: run.run_key, action: "preparing_to_failed", details: { application_id: app.id } });
      }
      recordRunError(db, { runId: run.id, operation: "recovery", error: `Run ${run.run_key} found in 'running' state at startup; marked interrupted`, recoverable: false });
      completeRun(db, run.id, { status: "interrupted", notes: `Interrupted at stage ${run.current_stage ?? "unknown"}; recovered at ${nowIso()}` });
      actions.push({ run_id: run.id, run_key: run.run_key, action: "marked_interrupted", details: { stage: run.current_stage } });
    });
    tx();
  }
  return actions;
}

function skippedRunKey(base: string): string {
  return `${base}:skipped:${Date.now()}`;
}

/**
 * Starts a pipeline run if one is due (or forced), guarded by the persistent lock.
 * Overlapping runs are skipped and recorded; expired locks are taken over after recovery.
 */
export function startPipelineRun(db: DB, config: LoadedConfig, input: { trigger: RunTrigger; holder: string; force?: boolean; now?: Date }): StartResult {
  const now = input.now ?? new Date();
  const schedule = config.schedule;
  const lastCompleted = getState<string | null>(db, STATE_LAST_COMPLETED_SLOT, null);
  const due = dueSlot(now, schedule, lastCompleted);
  const forced = input.force || input.trigger === "manual";

  let runKey: string;
  if (due) runKey = due.key;
  else if (forced) runKey = `manual:${now.toISOString()}`;
  else {
    const next = nextSlot(now, schedule);
    return { status: "skipped", run: null, run_key: "", reason: `No scheduled slot due (last completed ${lastCompleted ?? "none"}; next ${next.key} ${schedule.timezone})`, recovered: [], lock: getLock(db, PIPELINE_LOCK) };
  }

  const existing = db.prepare("SELECT id, status FROM search_runs WHERE run_key = ?").get(runKey) as { id: number; status: string } | undefined;
  if (existing && existing.status !== "running") {
    if (existing.status === "completed") setState(db, STATE_LAST_COMPLETED_SLOT, runKey);
    return { status: "skipped", run: getRun(db, existing.id), run_key: runKey, reason: `Slot ${runKey} already ${existing.status}`, recovered: [], lock: getLock(db, PIPELINE_LOCK) };
  }

  const lock = acquireLock(db, PIPELINE_LOCK, input.holder, schedule.lock_ttl_minutes);
  if (!lock.acquired) {
    const rec = createRun(db, { runKey: skippedRunKey(runKey), trigger: input.trigger, notes: `Skipped: overlapping run (${lock.reason})` });
    completeRun(db, rec.run.id, { status: "skipped", notes: `Overlap with lock ${lock.lock?.holder} (run ${lock.lock?.run_id ?? "?"}); policy ${schedule.overlap_policy}` });
    return { status: "skipped", run: getRun(db, rec.run.id), run_key: runKey, reason: `Overlapping run: ${lock.reason}`, recovered: [], lock: lock.lock };
  }

  const recovered = recoverInterruptedRuns(db);
  const created = createRun(db, { runKey, trigger: input.trigger });
  db.prepare("UPDATE run_locks SET run_id = ? WHERE name = ? AND holder = ?").run(created.run.id, PIPELINE_LOCK, input.holder);
  return { status: "started", run: getRun(db, created.run.id), run_key: runKey, reason: lock.reason, recovered, lock: getLock(db, PIPELINE_LOCK) };
}

export function heartbeatPipeline(db: DB, config: LoadedConfig, holder: string): boolean {
  return heartbeatLock(db, PIPELINE_LOCK, holder, config.schedule.lock_ttl_minutes);
}

export function finishPipelineRun(
  db: DB,
  input: { runId: number; holder: string; status: "completed" | "failed"; stats?: RunStats; reportPath?: string | null; notes?: string | null },
): RunView {
  const run = completeRun(db, input.runId, { status: input.status, stats: input.stats, reportPath: input.reportPath, notes: input.notes });
  if (input.status === "completed" && !run.run_key.startsWith("manual:")) setState(db, STATE_LAST_COMPLETED_SLOT, run.run_key);
  releaseLock(db, PIPELINE_LOCK, input.holder);
  return run;
}

export interface ScheduleStatus {
  now: string;
  timezone: string;
  last_completed_slot: string | null;
  previous_slot: string | null;
  next_slot: string;
  next_slot_at: string;
  due_slot: string | null;
  seconds_until_next_slot: number;
  lock: (LockRecord & { expired: boolean }) | null;
  running_runs: Array<{ id: number; run_key: string; current_stage: string | null; started_at: string }>;
}

export function getScheduleStatus(db: DB, config: LoadedConfig, now: Date = new Date()): ScheduleStatus {
  const lastCompleted = getState<string | null>(db, STATE_LAST_COMPLETED_SLOT, null);
  const next = nextSlot(now, config.schedule);
  const prev = previousSlot(now, config.schedule);
  const due = dueSlot(now, config.schedule, lastCompleted);
  const lock = getLock(db, PIPELINE_LOCK);
  return {
    now: now.toISOString(),
    timezone: config.schedule.timezone,
    last_completed_slot: lastCompleted,
    previous_slot: prev?.key ?? null,
    next_slot: next.key,
    next_slot_at: next.at.toISOString(),
    due_slot: due?.key ?? null,
    seconds_until_next_slot: Math.max(0, Math.round((next.at.getTime() - now.getTime()) / 1000)),
    lock: lock ? { ...lock, expired: isLockExpired(lock, now) } : null,
    running_runs: listRuns(db, { status: "running", limit: 10 }).map((r) => ({ id: r.id, run_key: r.run_key, current_stage: r.current_stage, started_at: r.started_at })),
  };
}
