import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "../core/time.js";

export type DB = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "migrations");

export interface OpenOptions {
  /** file path or ':memory:' */
  dbPath: string;
  readonly?: boolean;
  /** run pending migrations on open (default true) */
  migrate?: boolean;
}

export function openDatabase(opts: OpenOptions): DB {
  if (opts.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  }
  const db = new Database(opts.dbPath, { readonly: opts.readonly ?? false });
  if (!opts.readonly) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  if (opts.migrate ?? true) {
    if (opts.readonly) throw new Error("Cannot migrate a readonly database");
    runMigrations(db);
  }
  return db;
}

export interface MigrationStatus {
  version: number;
  name: string;
  applied: boolean;
  appliedAt?: string;
}

function listMigrationFiles(): Array<{ version: number; name: string; file: string }> {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!m) throw new Error(`Bad migration filename: ${f}`);
      return { version: Number(m[1]), name: m[2]!, file: path.join(MIGRATIONS_DIR, f) };
    })
    .sort((a, b) => a.version - b.version);
}

export function migrationStatus(db: DB): MigrationStatus[] {
  ensureMigrationsTable(db);
  const applied = new Map<number, string>(
    (db.prepare("SELECT version, applied_at FROM schema_migrations").all() as Array<{ version: number; applied_at: string }>).map(
      (r) => [r.version, r.applied_at],
    ),
  );
  return listMigrationFiles().map((m) => ({
    version: m.version,
    name: m.name,
    applied: applied.has(m.version),
    appliedAt: applied.get(m.version),
  }));
}

function ensureMigrationsTable(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
}

/** Applies all pending migrations, each inside its own transaction. Idempotent. */
export function runMigrations(db: DB): number[] {
  ensureMigrationsTable(db);
  const appliedVersions = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of listMigrationFiles()) {
    if (appliedVersions.has(m.version)) continue;
    const sql = fs.readFileSync(m.file, "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, nowIso());
    });
    tx();
    applied.push(m.version);
  }
  return applied;
}

/** Runs fn inside a transaction (nested calls reuse the outer transaction via savepoints). */
export function inTransaction<T>(db: DB, fn: () => T): T {
  return db.transaction(fn)();
}

/** JSON helpers used by every repository. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
