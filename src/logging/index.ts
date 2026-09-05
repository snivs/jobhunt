import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  dir: string;
  level: LogLevel;
  component: string;
  runId?: number | null;
  /** also mirror to stderr (never stdout: the MCP server owns stdout) */
  stderr?: boolean;
}

/**
 * Minimal structured JSONL logger. One file per day under logs/, safe for concurrent appenders.
 * Everything the agent does can be reconstructed from these files plus SQLite, without the chat history.
 */
export class Logger {
  private readonly opts: LoggerOptions;

  constructor(opts: LoggerOptions) {
    this.opts = opts;
    fs.mkdirSync(opts.dir, { recursive: true });
  }

  child(component: string, runId?: number | null): Logger {
    return new Logger({ ...this.opts, component, runId: runId ?? this.opts.runId ?? null });
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.opts.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      component: this.opts.component,
      run_id: this.opts.runId ?? null,
      message,
      ...(data ?? {}),
    };
    const line = JSON.stringify(entry);
    const file = path.join(this.opts.dir, `jobhunt-${entry.ts.slice(0, 10)}.jsonl`);
    try {
      fs.appendFileSync(file, line + "\n", "utf8");
    } catch {
      /* logging must never break the pipeline */
    }
    if (this.opts.stderr) process.stderr.write(line + "\n");
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write("debug", message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.write("info", message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.write("warn", message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.write("error", message, data);
  }
}

export function errorToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
