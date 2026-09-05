import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const rateLimitSchema = z.object({
  requests_per_second: z.number().nonnegative(),
  requests_per_minute: z.number().nonnegative(),
  requests_per_hour: z.number().nonnegative(),
  concurrency: z.number().int().nonnegative(),
});

const retrySchema = z.object({
  max_retries: z.number().int().nonnegative(),
  initial_backoff_ms: z.number().nonnegative(),
  backoff_multiplier: z.number().positive(),
  max_backoff_ms: z.number().nonnegative(),
});

export const sourceConfigSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["api", "ats", "career_page", "aggregator", "platform", "manual"]),
  enabled: z.boolean().default(true),
  automation_policy: z.enum(["discover_only", "apply_allowed", "blocked"]).default("discover_only"),
  base_url: z.string().optional(),
  boards: z.array(z.string()).default([]),
  rate_limits: rateLimitSchema,
  retry: retrySchema,
  options: z.record(z.string(), z.unknown()).default({}),
});
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const weightsSchema = z.object({
  technical_match: z.number().nonnegative(),
  required_skill_match: z.number().nonnegative(),
  experience_match: z.number().nonnegative(),
  seniority_match: z.number().nonnegative(),
  leadership_match: z.number().nonnegative(),
  location_match: z.number().nonnegative(),
  language_match: z.number().nonnegative(),
  compensation_match: z.number().nonnegative(),
  industry_match: z.number().nonnegative(),
  responsibility_match: z.number().nonnegative(),
  preference_match: z.number().nonnegative(),
});
export type ScoringWeights = z.infer<typeof weightsSchema>;
export type ScoringFactor = keyof ScoringWeights;

export const configSchema = z.object({
  schedule: z.object({
    timezone: z.string().min(1),
    days: z.array(z.enum(WEEKDAYS)).min(1),
    times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
    overlap_policy: z.enum(["skip", "queue"]).default("skip"),
    lock_ttl_minutes: z.number().positive().default(90),
    slot_grace_minutes: z.number().nonnegative().default(120),
  }),
  matching: z.object({
    minimum_score: z.number().min(0).max(100).default(80),
    scoring_version: z.string().default("1.0"),
    weights: weightsSchema,
    undisclosed_compensation_score: z.number().min(0).max(100).default(60),
  }),
  applications: z.object({
    max_per_source_per_run: z.number().int().positive().default(3),
    automatic_submission: z.boolean().default(true),
    verify_job_active_before_submit: z.boolean().default(true),
    no_response_after_days: z.number().int().positive().default(30),
  }),
  research: z.object({
    top_n_per_run: z.number().int().nonnegative().default(5),
    research_ttl_days: z.number().int().positive().default(60),
  }),
  market: z.object({
    compensation_inference: z.boolean().default(true),
    skill_inference: z.boolean().default(true),
    snapshot_period_days: z.number().int().positive().default(30),
    min_sample_size: z.number().int().positive().default(3),
  }),
  vault: z.object({
    path: z.string().min(1),
    job_matches_note: z.string().default("Job Search/Job Matches.md"),
    reports_folder: z.string().default("Job Search/Reports"),
    companies_folder: z.string().default("Market Intelligence/Companies"),
    skills_folder: z.string().default("Market Intelligence/Skills"),
  }),
  database: z.object({ path: z.string().min(1) }),
  logging: z.object({
    dir: z.string().default("./logs"),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
  sources: z.array(sourceConfigSchema),
});
export type JobHuntConfig = z.infer<typeof configSchema>;

export interface LoadedConfig extends JobHuntConfig {
  /** absolute path of the project root the config was resolved against */
  rootDir: string;
  configPath: string;
}

function resolveFrom(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/** Loads config/jobhunt.yaml (or JOBHUNT_CONFIG_PATH), validates it and applies env overrides. */
export function loadConfig(options: { configPath?: string; rootDir?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? findProjectRoot();
  loadDotEnv(rootDir, env);
  const configPath = resolveFrom(rootDir, options.configPath ?? env.JOBHUNT_CONFIG_PATH ?? "config/jobhunt.yaml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = parseYaml(fs.readFileSync(configPath, "utf8"));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config ${configPath}: ${parsed.error.message}`);
  }
  const cfg = parsed.data;
  const keys = new Set<string>();
  for (const s of cfg.sources) {
    if (keys.has(s.key)) throw new Error(`Duplicate source key in config: ${s.key}`);
    keys.add(s.key);
  }
  const vaultPath = resolveFrom(rootDir, env.OBSIDIAN_VAULT_PATH ?? cfg.vault.path);
  const dbPath = resolveFrom(rootDir, env.JOBHUNT_DB_PATH ?? cfg.database.path);
  return {
    ...cfg,
    vault: { ...cfg.vault, path: vaultPath },
    database: { path: dbPath },
    logging: { ...cfg.logging, dir: resolveFrom(rootDir, cfg.logging.dir) },
    rootDir,
    configPath,
  };
}

/** Walks up from cwd (or JOBHUNT_ROOT) looking for package.json with name "jobhunt". */
export function findProjectRoot(start: string = process.env.JOBHUNT_ROOT ?? process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (json.name === "jobhunt") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

/** Loads .env from the project root into process.env without overriding existing values. */
export function loadDotEnv(rootDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = path.join(rootDir, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined && value !== "") env[key] = value;
  }
}
