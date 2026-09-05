import type { SourceConfig } from "../../config/index.js";
import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";

export interface SourceRow {
  id: number;
  key: string;
  name: string;
  kind: string;
  base_url: string | null;
  automation_policy: "discover_only" | "apply_allowed" | "blocked";
  enabled: number;
  config_json: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Upserts the configured sources into the DB (config is the source of truth for policy). */
export function syncSources(db: DB, sources: SourceConfig[]): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  const now = nowIso();
  const select = db.prepare("SELECT id FROM sources WHERE key = ?");
  const insert = db.prepare(
    `INSERT INTO sources (key, name, kind, base_url, automation_policy, enabled, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE sources SET name = ?, kind = ?, base_url = ?, automation_policy = ?, enabled = ?, config_json = ?, updated_at = ? WHERE key = ?`,
  );
  const tx = db.transaction(() => {
    for (const s of sources) {
      const cfg = toJson({ rate_limits: s.rate_limits, retry: s.retry, boards: s.boards, options: s.options });
      if (select.get(s.key)) {
        update.run(s.name, s.kind, s.base_url ?? null, s.automation_policy, s.enabled ? 1 : 0, cfg, now, s.key);
        updated++;
      } else {
        insert.run(s.key, s.name, s.kind, s.base_url ?? null, s.automation_policy, s.enabled ? 1 : 0, cfg, now, now);
        inserted++;
      }
    }
  });
  tx();
  return { inserted, updated };
}

export function getSourceByKey(db: DB, key: string): SourceRow | null {
  return (db.prepare("SELECT * FROM sources WHERE key = ?").get(key) as SourceRow | undefined) ?? null;
}

export function getSourceById(db: DB, id: number): SourceRow | null {
  return (db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined) ?? null;
}

export function requireSource(db: DB, key: string): SourceRow {
  const s = getSourceByKey(db, key);
  if (!s) throw new Error(`Unknown source '${key}'. Run sources:sync or add it to config/jobhunt.yaml`);
  return s;
}

export function listSources(db: DB, opts: { enabledOnly?: boolean } = {}): SourceRow[] {
  const sql = opts.enabledOnly ? "SELECT * FROM sources WHERE enabled = 1 ORDER BY key" : "SELECT * FROM sources ORDER BY key";
  return db.prepare(sql).all() as SourceRow[];
}

export function sourceConfig<T = Record<string, unknown>>(row: SourceRow): T {
  return fromJson<T>(row.config_json, {} as T);
}

export function markSourceRun(db: DB, sourceId: number, result: { success: boolean; error?: string | null }): void {
  const now = nowIso();
  if (result.success) {
    db.prepare("UPDATE sources SET last_run_at = ?, last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(now, now, now, sourceId);
  } else {
    db.prepare("UPDATE sources SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(now, result.error ?? "unknown error", now, sourceId);
  }
}
