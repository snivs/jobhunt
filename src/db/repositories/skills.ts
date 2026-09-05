import { normalizeText } from "../../core/normalize.js";
import { nowIso } from "../../core/time.js";
import type { DB } from "../index.js";

export type SkillCategory =
  | "language" | "framework" | "library" | "database" | "cloud" | "devops" | "infrastructure" | "architecture" | "practice"
  | "ai" | "tool" | "domain" | "soft" | "security" | "data" | "mobile" | "other";

export type MentionType = "explicit_required" | "explicit_preferred" | "mentioned" | "expected";

export interface SkillRow {
  id: number;
  name: string;
  slug: string;
  category: SkillCategory;
  created_at: string;
}

export interface JobSkillRow {
  id: number;
  job_id: number;
  skill_id: number;
  mention_type: MentionType;
  confidence: number;
  evidence: string | null;
  raw_form: string | null;
  years_required: number | null;
  extracted_by: string;
  created_at: string;
  updated_at: string;
  skill_name: string;
  skill_slug: string;
  category: SkillCategory;
}

/** Canonical slug: lowercase, accents removed, non-alphanumerics collapsed to '-', keeps + and # (c++, c#). */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.js\b/g, "js")
    .replace(/[^a-z0-9+#]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || normalizeText(name).replace(/\s+/g, "-");
}

/** Built-in aliases so common variants normalize to one skill. Extend freely; user data adds more via skill_aliases. */
const BUILTIN_ALIASES: Record<string, string[]> = {
  JavaScript: ["js", "ecmascript", "es6", "es2015+"],
  TypeScript: ["ts"],
  "Node.js": ["node", "nodejs", "node js"],
  React: ["reactjs", "react.js"],
  "Vue.js": ["vue", "vuejs"],
  Angular: ["angularjs", "angular 2+"],
  "Next.js": ["nextjs", "next"],
  PostgreSQL: ["postgres", "psql", "postgresql database"],
  MySQL: ["my sql"],
  MongoDB: ["mongo"],
  AWS: ["amazon web services"],
  GCP: ["google cloud", "google cloud platform"],
  Azure: ["microsoft azure"],
  Kubernetes: ["k8s"],
  Docker: ["containers", "docker compose"],
  Terraform: ["iac terraform"],
  "CI/CD": ["ci cd", "continuous integration", "continuous delivery", "cicd"],
  Python: ["python3", "python 3"],
  "C#": ["csharp", "c sharp"],
  ".NET": ["dotnet", "dot net", ".net core", "asp.net", "asp.net core"],
  Java: ["java 8", "java 11", "java 17"],
  Go: ["golang"],
  "C++": ["cpp"],
  SQL: ["structured query language"],
  GraphQL: ["graph ql"],
  "REST APIs": ["rest", "restful", "rest api", "restful apis", "http apis"],
  Microservices: ["micro services", "microservice architecture"],
  "Distributed Systems": ["distributed computing"],
  "Machine Learning": ["ml"],
  "Large Language Models": ["llm", "llms", "large language model"],
  "Model Context Protocol": ["mcp", "mcp servers"],
  "Claude Code": ["claude"],
  "AI Agents": ["agents", "agentic", "agentic workflows", "ai agent"],
  "Unit Testing": ["unit tests", "testing"],
  Git: ["github", "gitlab", "version control"],
  Linux: ["unix"],
  Redis: ["redis cache"],
  Kafka: ["apache kafka"],
  RabbitMQ: ["rabbit mq"],
  "System Design": ["systems design", "architecture design"],
  Agile: ["scrum", "agile methodologies", "kanban"],
  "Team Leadership": ["leadership", "people management", "team lead", "leading teams"],
  English: ["english language", "fluent english"],
  Spanish: ["spanish language"],
};

const seededDatabases = new WeakSet<DB>();

/** Seeds built-in aliases once per database connection (idempotent, cheap). */
export function seedSkillAliases(db: DB): void {
  if (seededDatabases.has(db)) return;
  const tx = db.transaction(() => {
    for (const [name, aliases] of Object.entries(BUILTIN_ALIASES)) {
      const skill = ensureSkillRaw(db, name, guessCategory(name));
      for (const alias of aliases) addAlias(db, skill.id, alias);
    }
  });
  tx();
  seededDatabases.add(db);
}

function guessCategory(name: string): SkillCategory {
  const n = name.toLowerCase();
  if (/^(javascript|typescript|python|java|go|c\+\+|c#|rust|ruby|php|kotlin|swift|scala|sql)$/.test(n)) return "language";
  if (/(react|vue|angular|next|node|\.net|spring|django|rails|express)/.test(n)) return "framework";
  if (/(postgres|mysql|mongo|redis|sql server|dynamo|cassandra|elasticsearch)/.test(n)) return "database";
  if (/^(aws|gcp|azure)$/.test(n)) return "cloud";
  if (/(kubernetes|docker|terraform|ci\/cd|ansible|helm)/.test(n)) return "devops";
  if (/(kafka|rabbitmq)/.test(n)) return "infrastructure";
  if (/(microservices|distributed|system design|rest|graphql)/.test(n)) return "architecture";
  if (/(machine learning|language model|context protocol|claude|agents)/.test(n)) return "ai";
  if (/(testing|agile|git)/.test(n)) return "practice";
  if (/(leadership)/.test(n)) return "soft";
  if (/(english|spanish)/.test(n)) return "domain";
  return "other";
}

function addAlias(db: DB, skillId: number, alias: string): void {
  const normalized = normalizeText(alias);
  if (!normalized) return;
  db.prepare("INSERT OR IGNORE INTO skill_aliases (skill_id, alias, normalized_alias) VALUES (?, ?, ?)").run(skillId, alias, normalized);
}

function ensureSkillRaw(db: DB, name: string, category?: SkillCategory): SkillRow {
  const slug = slugify(name);
  const existing = db.prepare("SELECT * FROM skills WHERE slug = ?").get(slug) as SkillRow | undefined;
  if (existing) {
    if (category && existing.category === "other" && category !== "other") {
      db.prepare("UPDATE skills SET category = ? WHERE id = ?").run(category, existing.id);
      return { ...existing, category };
    }
    return existing;
  }
  const res = db.prepare("INSERT INTO skills (name, slug, category, created_at) VALUES (?, ?, ?, ?)").run(name.trim(), slug, category ?? "other", nowIso());
  return db.prepare("SELECT * FROM skills WHERE id = ?").get(Number(res.lastInsertRowid)) as SkillRow;
}

/** Resolves a raw skill mention to the canonical skill, creating it when unknown. */
export function ensureSkill(db: DB, rawName: string, category?: SkillCategory, aliases: string[] = []): SkillRow {
  seedSkillAliases(db);
  const trimmed = rawName.trim();
  if (!trimmed) throw new Error("Skill name is required");
  const tx = db.transaction(() => {
    const viaAlias = findSkillByAlias(db, trimmed);
    const skill = viaAlias ?? ensureSkillRaw(db, trimmed, category);
    for (const a of aliases) addAlias(db, skill.id, a);
    return skill;
  });
  return tx();
}

export function findSkillByAlias(db: DB, raw: string): SkillRow | null {
  const normalized = normalizeText(raw);
  const bySlug = db.prepare("SELECT * FROM skills WHERE slug = ?").get(slugify(raw)) as SkillRow | undefined;
  if (bySlug) return bySlug;
  const byAlias = db
    .prepare("SELECT s.* FROM skill_aliases a JOIN skills s ON s.id = a.skill_id WHERE a.normalized_alias = ?")
    .get(normalized) as SkillRow | undefined;
  return byAlias ?? null;
}

export function getSkillBySlug(db: DB, slug: string): SkillRow | null {
  return (db.prepare("SELECT * FROM skills WHERE slug = ?").get(slug) as SkillRow | undefined) ?? null;
}

export function searchSkills(db: DB, query: string, limit = 25): Array<SkillRow & { job_count: number }> {
  const q = `%${normalizeText(query)}%`;
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(DISTINCT js.job_id) FROM job_skills js WHERE js.skill_id = s.id) AS job_count
       FROM skills s
       WHERE s.slug LIKE ? OR lower(s.name) LIKE ? OR s.id IN (SELECT skill_id FROM skill_aliases WHERE normalized_alias LIKE ?)
       ORDER BY job_count DESC, s.name LIMIT ?`,
    )
    .all(q, q, q, limit) as Array<SkillRow & { job_count: number }>;
}

export interface JobSkillInput {
  jobId: number;
  skillName: string;
  category?: SkillCategory;
  mentionType: MentionType;
  confidence: number;
  evidence?: string | null;
  rawForm?: string | null;
  yearsRequired?: number | null;
  extractedBy?: string;
}

/** Upsert on (job, skill, mention_type). Explicit mentions are never downgraded to expected. */
export function recordJobSkill(db: DB, input: JobSkillInput): JobSkillRow {
  if (input.confidence < 0 || input.confidence > 1) throw new Error("confidence must be between 0 and 1");
  const now = nowIso();
  const tx = db.transaction(() => {
    const skill = ensureSkill(db, input.skillName, input.category);
    db.prepare(
      `INSERT INTO job_skills (job_id, skill_id, mention_type, confidence, evidence, raw_form, years_required, extracted_by, created_at, updated_at)
       VALUES (@job_id, @skill_id, @mention_type, @confidence, @evidence, @raw_form, @years_required, @extracted_by, @now, @now)
       ON CONFLICT(job_id, skill_id, mention_type) DO UPDATE SET
         confidence = MAX(job_skills.confidence, excluded.confidence),
         evidence = COALESCE(job_skills.evidence, excluded.evidence),
         raw_form = COALESCE(job_skills.raw_form, excluded.raw_form),
         years_required = COALESCE(job_skills.years_required, excluded.years_required),
         updated_at = excluded.updated_at`,
    ).run({
      job_id: input.jobId,
      skill_id: skill.id,
      mention_type: input.mentionType,
      confidence: input.confidence,
      evidence: input.evidence ?? null,
      raw_form: input.rawForm ?? input.skillName,
      years_required: input.yearsRequired ?? null,
      extracted_by: input.extractedBy ?? "agent",
      now,
    });
    return db
      .prepare(
        `SELECT js.*, s.name AS skill_name, s.slug AS skill_slug, s.category FROM job_skills js JOIN skills s ON s.id = js.skill_id
         WHERE js.job_id = ? AND js.skill_id = ? AND js.mention_type = ?`,
      )
      .get(input.jobId, skill.id, input.mentionType) as JobSkillRow;
  });
  return tx();
}

export function getJobSkills(db: DB, jobId: number): JobSkillRow[] {
  return db
    .prepare(
      `SELECT js.*, s.name AS skill_name, s.slug AS skill_slug, s.category FROM job_skills js JOIN skills s ON s.id = js.skill_id
       WHERE js.job_id = ? ORDER BY CASE js.mention_type WHEN 'explicit_required' THEN 0 WHEN 'explicit_preferred' THEN 1 WHEN 'mentioned' THEN 2 ELSE 3 END, s.name`,
    )
    .all(jobId) as JobSkillRow[];
}

export interface DemandFilters {
  periodStart?: string;
  periodEnd?: string;
  sourceKey?: string;
  seniority?: string;
  workMode?: string;
  titleContains?: string;
  country?: string;
  mentionTypes?: MentionType[];
  category?: SkillCategory;
  limit?: number;
  /** compare against the immediately preceding window of the same length */
  compareWithPreviousPeriod?: boolean;
}

export interface SkillDemandRow {
  skill_id: number;
  name: string;
  slug: string;
  category: SkillCategory;
  job_count: number;
  mention_count: number;
  explicit_required: number;
  explicit_preferred: number;
  mentioned: number;
  expected: number;
  share_of_jobs: number;
  previous_job_count?: number;
  growth_pct?: number | null;
}

function demandQuery(db: DB, f: DemandFilters, periodStart?: string, periodEnd?: string): { rows: Omit<SkillDemandRow, "share_of_jobs">[]; totalJobs: number } {
  const where: string[] = ["j.duplicate_of_job_id IS NULL"];
  const params: Record<string, unknown> = {};
  if (periodStart) {
    where.push("j.discovered_at >= @periodStart");
    params.periodStart = periodStart;
  }
  if (periodEnd) {
    where.push("j.discovered_at < @periodEnd");
    params.periodEnd = periodEnd;
  }
  if (f.sourceKey) {
    where.push("s.key = @sourceKey");
    params.sourceKey = f.sourceKey;
  }
  if (f.seniority) {
    where.push("j.seniority = @seniority");
    params.seniority = f.seniority;
  }
  if (f.workMode) {
    where.push("j.work_mode = @workMode");
    params.workMode = f.workMode;
  }
  if (f.country) {
    where.push("lower(j.country) = lower(@country)");
    params.country = f.country;
  }
  if (f.titleContains) {
    where.push("j.normalized_title LIKE @title");
    params.title = `%${normalizeText(f.titleContains)}%`;
  }
  const mentionFilter = f.mentionTypes && f.mentionTypes.length ? `AND js.mention_type IN (${f.mentionTypes.map((m) => `'${m}'`).join(",")})` : "";
  const categoryFilter = f.category ? "AND sk.category = @category" : "";
  if (f.category) params.category = f.category;
  const w = `WHERE ${where.join(" AND ")}`;
  const totalJobs = (
    db.prepare(`SELECT COUNT(*) AS c FROM jobs j JOIN sources s ON s.id = j.source_id ${w}`).get(params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT sk.id AS skill_id, sk.name, sk.slug, sk.category,
         COUNT(DISTINCT js.job_id) AS job_count,
         COUNT(*) AS mention_count,
         SUM(CASE WHEN js.mention_type = 'explicit_required' THEN 1 ELSE 0 END) AS explicit_required,
         SUM(CASE WHEN js.mention_type = 'explicit_preferred' THEN 1 ELSE 0 END) AS explicit_preferred,
         SUM(CASE WHEN js.mention_type = 'mentioned' THEN 1 ELSE 0 END) AS mentioned,
         SUM(CASE WHEN js.mention_type = 'expected' THEN 1 ELSE 0 END) AS expected
       FROM job_skills js
       JOIN skills sk ON sk.id = js.skill_id
       JOIN jobs j ON j.id = js.job_id
       JOIN sources s ON s.id = j.source_id
       ${w} ${mentionFilter} ${categoryFilter}
       GROUP BY sk.id ORDER BY job_count DESC, mention_count DESC, sk.name LIMIT @limit`,
    )
    .all({ ...params, limit: f.limit ?? 50 }) as Omit<SkillDemandRow, "share_of_jobs">[];
  return { rows, totalJobs };
}

/** Skill demand: distinct jobs vs raw mentions are reported separately, never conflated. */
export function getSkillMarketDemand(db: DB, f: DemandFilters = {}): { total_jobs: number; period: { start: string | null; end: string | null }; skills: SkillDemandRow[] } {
  const current = demandQuery(db, f, f.periodStart, f.periodEnd);
  let previous: Map<number, number> | null = null;
  if (f.compareWithPreviousPeriod && f.periodStart) {
    const start = new Date(f.periodStart);
    const end = f.periodEnd ? new Date(f.periodEnd) : new Date();
    const len = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - len).toISOString();
    const prev = demandQuery(db, { ...f, limit: 10_000 }, prevStart, f.periodStart);
    previous = new Map(prev.rows.map((r) => [r.skill_id, r.job_count]));
  }
  const skills = current.rows.map((r) => {
    const out: SkillDemandRow = { ...r, share_of_jobs: current.totalJobs ? Math.round((r.job_count / current.totalJobs) * 1000) / 10 : 0 };
    if (previous) {
      const p = previous.get(r.skill_id) ?? 0;
      out.previous_job_count = p;
      out.growth_pct = p > 0 ? Math.round(((r.job_count - p) / p) * 1000) / 10 : null;
    }
    return out;
  });
  return { total_jobs: current.totalJobs, period: { start: f.periodStart ?? null, end: f.periodEnd ?? null }, skills };
}

export function getSkillCooccurrence(db: DB, slug: string, limit = 15, periodStart?: string): Array<{ name: string; slug: string; job_count: number }> {
  const params: Record<string, unknown> = { slug, limit };
  const period = periodStart ? "AND j.discovered_at >= @periodStart" : "";
  if (periodStart) params.periodStart = periodStart;
  return db
    .prepare(
      `SELECT s2.name, s2.slug, COUNT(DISTINCT a.job_id) AS job_count
       FROM job_skills a
       JOIN skills s1 ON s1.id = a.skill_id AND s1.slug = @slug
       JOIN job_skills b ON b.job_id = a.job_id AND b.skill_id <> a.skill_id
       JOIN skills s2 ON s2.id = b.skill_id
       JOIN jobs j ON j.id = a.job_id AND j.duplicate_of_job_id IS NULL ${period}
       GROUP BY s2.id ORDER BY job_count DESC LIMIT @limit`,
    )
    .all(params) as Array<{ name: string; slug: string; job_count: number }>;
}

/** Skills in demand (explicit mentions) that the candidate does not have. */
export function getCandidateSkillGaps(db: DB, opts: { periodStart?: string; limit?: number } = {}): SkillDemandRow[] {
  const demand = getSkillMarketDemand(db, { periodStart: opts.periodStart, mentionTypes: ["explicit_required", "explicit_preferred"], limit: 200 });
  const mine = new Set((db.prepare("SELECT skill_id FROM candidate_skills").all() as Array<{ skill_id: number }>).map((r) => r.skill_id));
  return demand.skills.filter((s) => !mine.has(s.skill_id)).slice(0, opts.limit ?? 25);
}
