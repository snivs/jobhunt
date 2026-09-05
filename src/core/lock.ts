import type { DB } from "../db/index.js";
import { addMinutes } from "./time.js";

export const PIPELINE_LOCK = "pipeline";

export interface LockRecord {
  name: string;
  holder: string;
  run_id: number | null;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface AcquireResult {
  acquired: boolean;
  lock: LockRecord | null;
  /** when not acquired: who holds it; when taken over: that an expired lock was replaced */
  reason?: string;
  /** the previous (expired) lock that was taken over, if any - its run must be recovered */
  tookOver?: LockRecord;
}

/**
 * Persistent lease-based lock. A lock whose expires_at is in the past is considered dead
 * (crashed run) and may be taken over; the caller is responsible for recovering the dead run.
 */
export function acquireLock(db: DB, name: string, holder: string, ttlMinutes: number, runId: number | null = null): AcquireResult {
  const now = new Date();
  const tx = db.transaction((): AcquireResult => {
    const existing = db.prepare("SELECT * FROM run_locks WHERE name = ?").get(name) as LockRecord | undefined;
    let tookOver: LockRecord | undefined;
    if (existing) {
      const expired = new Date(existing.expires_at).getTime() <= now.getTime();
      if (!expired && existing.holder !== holder) {
        return { acquired: false, lock: existing, reason: `held by ${existing.holder} until ${existing.expires_at}` };
      }
      if (expired && existing.holder !== holder) tookOver = existing;
    }
    const record: LockRecord = {
      name,
      holder,
      run_id: runId,
      acquired_at: now.toISOString(),
      expires_at: addMinutes(now, ttlMinutes).toISOString(),
      heartbeat_at: now.toISOString(),
    };
    db.prepare(
      `INSERT INTO run_locks (name, holder, run_id, acquired_at, expires_at, heartbeat_at)
       VALUES (@name, @holder, @run_id, @acquired_at, @expires_at, @heartbeat_at)
       ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, run_id = excluded.run_id,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at`,
    ).run(record);
    return { acquired: true, lock: record, reason: tookOver ? "took over expired lock" : undefined, tookOver };
  });
  return tx();
}

/** Extends the lease. Returns false if the lock is no longer held by `holder`. */
export function heartbeatLock(db: DB, name: string, holder: string, ttlMinutes: number): boolean {
  const now = new Date();
  const res = db
    .prepare("UPDATE run_locks SET heartbeat_at = ?, expires_at = ? WHERE name = ? AND holder = ?")
    .run(now.toISOString(), addMinutes(now, ttlMinutes).toISOString(), name, holder);
  return res.changes === 1;
}

export function releaseLock(db: DB, name: string, holder: string): boolean {
  const res = db.prepare("DELETE FROM run_locks WHERE name = ? AND holder = ?").run(name, holder);
  return res.changes === 1;
}

export function getLock(db: DB, name: string): LockRecord | null {
  return (db.prepare("SELECT * FROM run_locks WHERE name = ?").get(name) as LockRecord | undefined) ?? null;
}

export function isLockExpired(lock: LockRecord, now: Date = new Date()): boolean {
  return new Date(lock.expires_at).getTime() <= now.getTime();
}
