#!/usr/bin/env node
/**
 * Job Database MCP server (stdio).
 * High-level, typed tools over SQLite. Never exposes raw SQL. All writes are validated,
 * parameterized, transactional and idempotent where possible. Logs go to files/stderr only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "../config/index.js";
import { ingestRawJob } from "../core/ingest.js";
import { rescorePending, scoringOptionsFromConfig } from "../core/rescore.js";
import { finishPipelineRun, getScheduleStatus, heartbeatPipeline, startPipelineRun } from "../core/run-manager.js";
import { explainMatch, scoreJob, type JobAnalysis, type JobSkillRequirement } from "../core/scoring.js";
import { APPLICATION_STATES } from "../core/state-machine.js";
import { daysAgoIso, nowIso } from "../core/time.js";
import { openDatabase } from "../db/index.js";
import {
  assertCanSubmit,
  getApplication,
  getApplicationByJob,
  getApplicationCandidates,
  getApplicationStatistics,
  getOrCreateApplication,
  listApplications,
  markNoResponse,
  transitionApplication,
  updateApplication,
} from "../db/repositories/applications.js";
import { getCompanyById, getCompanyByName, searchCompanies, updateCompany, upsertCompany } from "../db/repositories/companies.js";
import { getCompensationStatistics, getJobCompensation, recordCompensation } from "../db/repositories/compensation.js";
import { getJob, getJobVersions, searchJobs, updateJob } from "../db/repositories/jobs.js";
import { getMarketSnapshots, getMarketStatistics, getSourceStatistics, saveMarketSnapshot } from "../db/repositories/market.js";
import { getLatestMatch, getMatchHistory, getMatchingJobs, recordMatch } from "../db/repositories/matches.js";
import { buildScoringProfile, getCandidateProfile, getProfileRow, removeCandidateSkill, setCandidateSkill, setPreference, upsertProfile } from "../db/repositories/profile.js";
import { getCompaniesNeedingResearch, getLatestCompanyResearch, recordCompanyResearch } from "../db/repositories/research.js";
import { getRun, getRunByKey, getRunSourceResults, getState, listRuns, PIPELINE_STAGES, recordRunError, recordSourceResult, setState, updateRunStage, updateRunStats } from "../db/repositories/runs.js";
import { ensureSkill, getCandidateSkillGaps, getJobSkills, getSkillCooccurrence, getSkillMarketDemand, recordJobSkill, searchSkills, seedSkillAliases } from "../db/repositories/skills.js";
import { listSources, requireSource, syncSources } from "../db/repositories/sources.js";
import { errorToString, Logger } from "../logging/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let config = loadConfig({ rootDir });
let configMtime = safeMtime(config.configPath);
const db = openDatabase({ dbPath: config.database.path });
syncSources(db, config.sources);
seedSkillAliases(db);

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Hot-reloads config/jobhunt.yaml when it changes on disk, so threshold/weight/source edits apply without restarting the server. */
function refreshConfig(): void {
  const mtime = safeMtime(config.configPath);
  if (mtime === configMtime) return;
  try {
    const next = loadConfig({ rootDir });
    config = next;
    configMtime = mtime;
    syncSources(db, config.sources);
    logger.info("config reloaded", { path: config.configPath });
  } catch (err) {
    logger.error("config reload failed; keeping previous config", { error: errorToString(err) });
    configMtime = mtime;
  }
}
const logger = new Logger({ dir: config.logging.dir, level: config.logging.level, component: "mcp", stderr: process.env.JOBHUNT_LOG_STDERR === "1" });

const server = new McpServer({ name: "jobhunt-db", version: "0.1.0" });

type Shape = z.ZodRawShape;
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data ?? null, null, 2) }] };
}
type ToolCallback = Parameters<typeof server.registerTool>[2];
function tool<S extends Shape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => unknown): void {
  const callback = async (args: z.infer<z.ZodObject<S>>) => {
    try {
      refreshConfig();
      const result = handler(args);
      return ok(result);
    } catch (err) {
      const message = errorToString(err);
      logger.error(`tool ${name} failed`, { error: message, args });
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
    }
  };
  server.registerTool(name, { description, inputSchema: shape }, callback as unknown as ToolCallback);
}

const workMode = z.enum(["remote", "hybrid", "onsite", "unknown"]);
const seniority = z.enum(["intern", "junior", "mid", "senior", "staff", "lead", "principal", "manager", "director", "executive", "unknown"]);
const employmentType = z.enum(["full_time", "part_time", "contract", "freelance", "internship", "unknown"]);
const jobStatus = z.enum(["active", "expired", "closed", "filled", "unknown"]);
const mentionType = z.enum(["explicit_required", "explicit_preferred", "mentioned", "expected"]);
const skillCategory = z.enum(["language", "framework", "library", "database", "cloud", "devops", "infrastructure", "architecture", "practice", "ai", "tool", "domain", "soft", "security", "data", "mobile", "other"]);
const skillLevel = z.enum(["expert", "advanced", "intermediate", "basic", "learning"]);
const langLevel = z.enum(["native", "c2", "c1", "b2", "b1", "a2", "a1"]);
const payPeriod = z.enum(["hour", "day", "week", "month", "year"]);
const appState = z.enum(APPLICATION_STATES);
const json = z.any();

// ───────────────────────────── sources / config ─────────────────────────────
tool("list_sources", "List configured job sources with their automation policy, rate limits and last run status.", {}, () =>
  listSources(db).map((s) => ({ ...s, config: JSON.parse(s.config_json ?? "{}") })),
);

tool("get_config", "Return the effective (non-secret) job hunter configuration: schedule, matching weights, application limits, vault paths.", {}, () => {
  const { sources, ...rest } = config;
  return { ...rest, sources: sources.map((s) => ({ key: s.key, name: s.name, kind: s.kind, enabled: s.enabled, automation_policy: s.automation_policy, boards: s.boards })) };
});

// ───────────────────────────── jobs ─────────────────────────────
tool(
  "search_jobs",
  "Search stored jobs with filters. Returns canonical (non-duplicate) jobs with their latest score and application status.",
  {
    query: z.string().optional().describe("free text over title, company, description, location"),
    status: z.union([jobStatus, z.literal("any")]).optional().describe("default: active"),
    source_key: z.string().optional(),
    work_mode: workMode.optional(),
    seniority: seniority.optional(),
    company_id: z.number().int().optional(),
    discovered_after: z.string().optional().describe("ISO timestamp"),
    min_score: z.number().optional(),
    eligible_only: z.boolean().optional(),
    unscored_only: z.boolean().optional().describe("only jobs without a match for the current profile/scoring version"),
    include_duplicates: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  },
  (a) => {
    const profile = getProfileRow(db);
    return searchJobs(db, {
      query: a.query,
      status: a.status,
      sourceKey: a.source_key,
      workMode: a.work_mode,
      seniority: a.seniority,
      companyId: a.company_id,
      discoveredAfter: a.discovered_after,
      minScore: a.min_score,
      eligibleOnly: a.eligible_only,
      unscoredOnly: a.unscored_only,
      includeDuplicates: a.include_duplicates,
      profileVersion: profile?.version,
      scoringVersion: config.matching.scoring_version,
      limit: a.limit,
      offset: a.offset,
    });
  },
);

tool("get_job", "Get one job with its skills, compensation observations, latest match, application and change history.", { job_id: z.number().int() }, (a) => {
  const job = getJob(db, a.job_id);
  if (!job) throw new Error(`Job ${a.job_id} not found`);
  return {
    job,
    company: job.company_id ? getCompanyById(db, job.company_id) : null,
    skills: getJobSkills(db, a.job_id),
    compensation: getJobCompensation(db, a.job_id),
    latest_match: getLatestMatch(db, a.job_id),
    application: getApplicationByJob(db, a.job_id),
    versions: getJobVersions(db, a.job_id),
  };
});

tool(
  "create_job",
  "Normalize and store a discovered job (idempotent: re-sending the same posting updates or leaves it unchanged; cross-source duplicates are flagged). Records a published salary range as an explicit compensation observation.",
  {
    source_key: z.string(),
    external_id: z.string().nullable().optional(),
    url: z.string().url(),
    title: z.string().min(1),
    company_name: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    country: z.string().nullable().optional().describe("ISO country name or code as given by the source"),
    work_mode: workMode.nullable().optional(),
    remote_scope: z.string().nullable().optional().describe("e.g. Worldwide, LATAM, USA only"),
    description: z.string().nullable().optional().describe("plain text or HTML"),
    posted_at: z.string().nullable().optional(),
    seniority: seniority.nullable().optional(),
    employment_type: employmentType.nullable().optional(),
    language: z.string().nullable().optional(),
    salary: z
      .object({ min: z.number().nullable().optional(), max: z.number().nullable().optional(), currency: z.string().nullable().optional(), period: z.string().nullable().optional(), text: z.string().nullable().optional() })
      .nullable()
      .optional(),
    raw_metadata: z.record(z.string(), json).nullable().optional(),
  },
  (a) =>
    ingestRawJob(db, {
      sourceKey: a.source_key,
      externalId: a.external_id ?? null,
      url: a.url,
      title: a.title,
      companyName: a.company_name ?? null,
      location: a.location ?? null,
      country: a.country ?? null,
      workMode: a.work_mode ?? null,
      remoteScope: a.remote_scope ?? null,
      description: a.description ?? null,
      postedAt: a.posted_at ?? null,
      seniority: a.seniority ?? null,
      employmentType: a.employment_type ?? null,
      language: a.language ?? null,
      salary: a.salary ?? null,
      rawMetadata: a.raw_metadata ?? null,
    }),
);

tool(
  "update_job",
  "Patch job attributes (status, seniority, work mode, country, etc.). History is preserved; nothing is deleted.",
  {
    job_id: z.number().int(),
    status: jobStatus.optional(),
    seniority: seniority.optional(),
    work_mode: workMode.optional(),
    employment_type: employmentType.optional(),
    country: z.string().nullable().optional(),
    remote_scope: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    company_id: z.number().int().nullable().optional(),
    description: z.string().nullable().optional(),
    last_verified_at: z.string().nullable().optional().describe("set to now when the posting was re-checked and is still open"),
  },
  (a) => {
    const { job_id, ...patch } = a;
    return updateJob(db, job_id, patch);
  },
);

// ───────────────────────────── companies ─────────────────────────────
tool("get_company", "Get a company by id or (normalized) name, with its latest research and open jobs.", { company_id: z.number().int().optional(), name: z.string().optional() }, (a) => {
  const company = a.company_id ? getCompanyById(db, a.company_id) : a.name ? getCompanyByName(db, a.name) : null;
  if (!company) return { company: null, candidates: a.name ? searchCompanies(db, a.name, 5) : [] };
  return { company, research: getLatestCompanyResearch(db, company.id), jobs: searchJobs(db, { companyId: company.id, limit: 20 }) };
});

const companyFields = {
  website: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  headquarters: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  vault_note: z.string().nullable().optional().describe("vault-relative path or wikilink of the company note"),
  metadata: z.record(z.string(), json).nullable().optional(),
};
tool("create_company", "Create a company (idempotent by normalized name; fills empty fields on an existing one).", { name: z.string().min(1), ...companyFields }, (a) => upsertCompany(db, a));
tool("update_company", "Update company fields.", { company_id: z.number().int(), name: z.string().optional(), ...companyFields }, (a) => {
  const { company_id, ...patch } = a;
  return updateCompany(db, company_id, patch);
});

// ───────────────────────────── skills ─────────────────────────────
tool("search_skills", "Search canonical skills (and aliases) with the number of jobs mentioning each.", { query: z.string(), limit: z.number().int().optional() }, (a) => searchSkills(db, a.query, a.limit));
tool("create_skill", "Create or resolve a canonical skill, optionally adding aliases.", { name: z.string(), category: skillCategory.optional(), aliases: z.array(z.string()).optional() }, (a) =>
  ensureSkill(db, a.name, a.category, a.aliases ?? []),
);
tool(
  "record_job_skill",
  "Record a skill observed on a job. mention_type distinguishes explicit_required / explicit_preferred / mentioned (stated by the employer) from expected (inferred). Never present inferred skills as explicit.",
  {
    job_id: z.number().int(),
    skill_name: z.string(),
    mention_type: mentionType,
    confidence: z.number().min(0).max(1),
    evidence: z.string().nullable().optional().describe("quote from the posting supporting the mention"),
    raw_form: z.string().nullable().optional().describe("how the skill appeared in the text"),
    years_required: z.number().nullable().optional(),
    category: skillCategory.optional(),
    extracted_by: z.string().optional(),
  },
  (a) =>
    recordJobSkill(db, {
      jobId: a.job_id,
      skillName: a.skill_name,
      mentionType: a.mention_type,
      confidence: a.confidence,
      evidence: a.evidence,
      rawForm: a.raw_form,
      yearsRequired: a.years_required,
      category: a.category,
      extractedBy: a.extracted_by,
    }),
);
tool("get_job_skills", "List skills recorded for a job.", { job_id: z.number().int() }, (a) => getJobSkills(db, a.job_id));
tool(
  "get_skill_market_demand",
  "Skill demand statistics: distinct jobs vs mentions, split by mention type, share of jobs, optional growth vs the previous period. Filter by period, source, seniority, title, work mode, country, category.",
  {
    period_days: z.number().int().optional().describe("shortcut: period_start = now - N days"),
    period_start: z.string().optional(),
    period_end: z.string().optional(),
    source_key: z.string().optional(),
    seniority: seniority.optional(),
    work_mode: workMode.optional(),
    title_contains: z.string().optional(),
    country: z.string().optional(),
    mention_types: z.array(mentionType).optional(),
    category: skillCategory.optional(),
    compare_with_previous_period: z.boolean().optional(),
    limit: z.number().int().optional(),
  },
  (a) =>
    getSkillMarketDemand(db, {
      periodStart: a.period_start ?? (a.period_days ? daysAgoIso(a.period_days) : undefined),
      periodEnd: a.period_end,
      sourceKey: a.source_key,
      seniority: a.seniority,
      workMode: a.work_mode,
      titleContains: a.title_contains,
      country: a.country,
      mentionTypes: a.mention_types,
      category: a.category,
      compareWithPreviousPeriod: a.compare_with_previous_period,
      limit: a.limit,
    }),
);
tool("get_skill_cooccurrence", "Skills that most frequently appear together with the given skill.", { skill_slug: z.string(), limit: z.number().int().optional(), period_start: z.string().optional() }, (a) =>
  getSkillCooccurrence(db, a.skill_slug, a.limit, a.period_start),
);
tool("get_candidate_skill_gaps", "Explicitly demanded skills the candidate does not have (learning investment candidates).", { period_days: z.number().int().optional(), limit: z.number().int().optional() }, (a) =>
  getCandidateSkillGaps(db, { periodStart: a.period_days ? daysAgoIso(a.period_days) : undefined, limit: a.limit }),
);

// ───────────────────────────── compensation ─────────────────────────────
tool(
  "record_compensation",
  "Record a compensation observation. observation_type 'explicit' = published by the employer; 'expected' = estimate (requires confidence + methodology). The two are never mixed in statistics.",
  {
    job_id: z.number().int().nullable().optional(),
    company_id: z.number().int().nullable().optional(),
    observation_type: z.enum(["explicit", "expected"]),
    min_amount: z.number().nullable().optional(),
    max_amount: z.number().nullable().optional(),
    currency: z.string().length(3),
    period: payPeriod,
    source: z.string().describe("job_posting | agent_estimate | levels.fyi | glassdoor | user | ..."),
    observed_at: z.string().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    methodology: z.string().nullable().optional(),
    evidence: z.string().nullable().optional(),
    equity: z.string().nullable().optional(),
    bonus: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    seniority: seniority.nullable().optional(),
    location: z.string().nullable().optional(),
  },
  (a) =>
    recordCompensation(db, {
      jobId: a.job_id,
      companyId: a.company_id,
      observationType: a.observation_type,
      minAmount: a.min_amount,
      maxAmount: a.max_amount,
      currency: a.currency,
      period: a.period,
      source: a.source,
      observedAt: a.observed_at,
      confidence: a.confidence,
      methodology: a.methodology,
      evidence: a.evidence,
      equity: a.equity,
      bonus: a.bonus,
      role: a.role,
      seniority: a.seniority,
      location: a.location,
    }),
);
tool(
  "get_compensation_statistics",
  "Annualized compensation statistics in one currency, reported separately for explicit (published) and expected (estimated) observations, with sample sizes.",
  {
    currency: z.string().optional().describe("default USD"),
    period_days: z.number().int().optional(),
    period_start: z.string().optional(),
    period_end: z.string().optional(),
    seniority: seniority.optional(),
    role: z.string().optional(),
    location: z.string().optional(),
    work_mode: workMode.optional(),
    source_key: z.string().optional(),
  },
  (a) =>
    getCompensationStatistics(db, {
      currency: a.currency,
      periodStart: a.period_start ?? (a.period_days ? daysAgoIso(a.period_days) : undefined),
      periodEnd: a.period_end,
      seniority: a.seniority,
      role: a.role,
      location: a.location,
      workMode: a.work_mode,
      sourceKey: a.source_key,
      minSampleSize: config.market.min_sample_size,
    }),
);

// ───────────────────────────── candidate profile ─────────────────────────────
tool("get_candidate_profile", "Get the candidate profile, skills, preferences and the derived scoring profile. Returns null when the interview has not been done.", {}, () => getCandidateProfile(db));
tool(
  "update_candidate_profile",
  "Create or patch the normalized candidate profile (operational fields only; the full narrative lives in the vault). Bumps the profile version so jobs are re-scored.",
  {
    full_name: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    current_title: z.string().nullable().optional(),
    seniority: seniority.nullable().optional(),
    years_experience: z.number().nullable().optional(),
    years_leadership: z.number().nullable().optional(),
    location: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    languages: z.array(z.object({ code: z.string(), level: langLevel })).optional(),
    work_authorization: z.array(z.string()).optional().describe("regions/countries where the candidate may legally work"),
    vault_note: z.string().nullable().optional(),
    interview_completed: z.boolean().optional(),
  },
  (a) => upsertProfile(db, a),
);
tool(
  "set_candidate_skill",
  "Add or update a candidate skill with level and years.",
  { skill_name: z.string(), level: skillLevel, years: z.number().nullable().optional(), is_primary: z.boolean().optional(), willing_to_learn: z.boolean().optional(), category: skillCategory.optional(), notes: z.string().nullable().optional() },
  (a) => setCandidateSkill(db, { skillName: a.skill_name, level: a.level, years: a.years, isPrimary: a.is_primary, willingToLearn: a.willing_to_learn, category: a.category, notes: a.notes }),
);
tool("remove_candidate_skill", "Remove a skill from the candidate profile.", { skill_slug: z.string() }, (a) => ({ removed: removeCandidateSkill(db, a.skill_slug) }));
tool(
  "set_candidate_preference",
  "Store a preference (any JSON value) under a key. Well-known keys: work_modes, acceptable_countries, relocation, compensation {minimum,target,currency,period}, industries_preferred, industries_avoided, responsibilities_wanted, responsibilities_unwanted, company_types_preferred, employment_types, target_titles, hard_constraints, auto_apply_allowed_fields, requires_approval_fields, resume_variants, standard_answers. is_hard_constraint makes work_modes/acceptable_countries/compensation/employment_types reject jobs outright.",
  { key: z.string(), value: json, is_hard_constraint: z.boolean().optional(), source: z.string().optional() },
  (a) => setPreference(db, a.key, a.value, { isHardConstraint: a.is_hard_constraint, source: a.source }),
);

// ───────────────────────────── matching ─────────────────────────────
const analysisSkill = z.object({
  name: z.string(),
  mention_type: mentionType,
  years_required: z.number().nullable().optional(),
  category: skillCategory.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().nullable().optional(),
});
tool(
  "calculate_job_match",
  "Score a job against the stored candidate profile using the configurable, explainable scoring model. Pass the structured analysis of the posting; omitted fields default to the stored job attributes. Records the match (and the skills, unless record_skills=false) and returns factor-level explanations, strengths, risks and hard-constraint failures.",
  {
    job_id: z.number().int(),
    run_id: z.number().int().nullable().optional(),
    seniority: seniority.optional(),
    work_mode: workMode.optional(),
    country: z.string().nullable().optional(),
    remote_scope: z.string().nullable().optional(),
    employment_type: employmentType.optional(),
    skills: z.array(analysisSkill).default([]),
    years_experience_required: z.number().nullable().optional(),
    leadership_required: z.boolean().default(false),
    team_size_to_lead: z.number().nullable().optional(),
    languages: z.array(z.object({ code: z.string(), min_level: langLevel, required: z.boolean() })).default([]),
    compensation: z
      .object({ min: z.number().nullable(), max: z.number().nullable(), currency: z.string().nullable(), period: z.enum(["year", "month", "hour", "day", "week"]).nullable(), explicit: z.boolean() })
      .nullable()
      .optional(),
    industry: z.string().nullable().optional(),
    company_type: z.string().nullable().optional(),
    responsibilities: z.array(z.string()).default([]),
    work_authorization_required: z.array(z.string()).nullable().optional(),
    missing_information: z.array(z.string()).default([]),
    record_skills: z.boolean().default(true),
  },
  (a) => {
    const job = getJob(db, a.job_id);
    if (!job) throw new Error(`Job ${a.job_id} not found`);
    const profile = buildScoringProfile(db);
    if (!profile) throw new Error("No candidate profile yet: run the interview (jobhunt-interview) before scoring");
    const skills: JobSkillRequirement[] = a.skills.map((s) => {
      const skill = ensureSkill(db, s.name, s.category);
      if (a.record_skills) {
        recordJobSkill(db, {
          jobId: job.id,
          skillName: skill.name,
          mentionType: s.mention_type,
          confidence: s.confidence ?? (s.mention_type === "expected" ? 0.6 : 0.85),
          evidence: s.evidence,
          rawForm: s.name,
          yearsRequired: s.years_required,
          category: s.category,
        });
      }
      return { slug: skill.slug, name: skill.name, mentionType: s.mention_type, yearsRequired: s.years_required ?? null };
    });
    const analysis: JobAnalysis = {
      jobId: job.id,
      title: job.title,
      seniority: a.seniority ?? job.seniority,
      workMode: a.work_mode ?? job.work_mode,
      country: a.country !== undefined ? a.country : job.country,
      remoteScope: a.remote_scope !== undefined ? a.remote_scope : job.remote_scope,
      employmentType: a.employment_type ?? job.employment_type,
      skills,
      yearsExperienceRequired: a.years_experience_required ?? null,
      leadershipRequired: a.leadership_required,
      teamSizeToLead: a.team_size_to_lead ?? null,
      languages: a.languages.map((l) => ({ code: l.code, minLevel: l.min_level, required: l.required })),
      compensation: a.compensation ?? null,
      industry: a.industry ?? null,
      companyType: a.company_type ?? null,
      responsibilities: a.responsibilities,
      workAuthorizationRequired: a.work_authorization_required ?? null,
      missingInformation: a.missing_information,
    };
    if (analysis.compensation?.explicit && analysis.compensation.currency && (analysis.compensation.min != null || analysis.compensation.max != null)) {
      recordCompensation(db, {
        jobId: job.id,
        companyId: job.company_id,
        observationType: "explicit",
        minAmount: analysis.compensation.min,
        maxAmount: analysis.compensation.max,
        currency: analysis.compensation.currency,
        period: analysis.compensation.period ?? "year",
        source: "job_posting",
        confidence: 1,
        role: job.title,
        seniority: analysis.seniority,
        location: job.location,
      });
    }
    const patch: Record<string, unknown> = {};
    if (a.seniority && a.seniority !== job.seniority) patch.seniority = a.seniority;
    if (a.work_mode && a.work_mode !== job.work_mode) patch.work_mode = a.work_mode;
    if (a.country !== undefined && a.country !== job.country) patch.country = a.country;
    if (a.remote_scope !== undefined && a.remote_scope !== job.remote_scope) patch.remote_scope = a.remote_scope;
    if (a.employment_type && a.employment_type !== job.employment_type) patch.employment_type = a.employment_type;
    if (Object.keys(patch).length) updateJob(db, job.id, patch);
    const result = scoreJob(profile, analysis, scoringOptionsFromConfig(config));
    const match = recordMatch(db, { jobId: job.id, profileVersion: profile.version, result, analysis, runId: a.run_id ?? null });
    return { match, explanation: explainMatch(result) };
  },
);
tool(
  "rescore_pending",
  "Re-score every active job whose stored analysis predates the current profile version or scoring version (after profile edits, weight or fx changes). Uses the stored structured analysis; never re-reads postings.",
  { run_id: z.number().int().nullable().optional(), limit: z.number().int().optional() },
  (a) => rescorePending(db, config, { runId: a.run_id, limit: a.limit }),
);
tool("get_job_match", "Latest match for a job plus its scoring history.", { job_id: z.number().int() }, (a) => ({ latest: getLatestMatch(db, a.job_id), history: getMatchHistory(db, a.job_id) }));
tool(
  "get_matching_jobs",
  "Best matching jobs (latest score per job), ordered by score then explicit compensation. Use eligible_only + min_score for application candidates.",
  {
    min_score: z.number().optional(),
    eligible_only: z.boolean().optional(),
    source_key: z.string().optional(),
    automation_policy: z.enum(["discover_only", "apply_allowed", "blocked"]).optional(),
    exclude_applied: z.boolean().optional(),
    active_only: z.boolean().optional(),
    limit: z.number().int().optional(),
  },
  (a) =>
    getMatchingJobs(db, { minScore: a.min_score, eligibleOnly: a.eligible_only, sourceKey: a.source_key, automationPolicy: a.automation_policy, excludeApplied: a.exclude_applied, activeOnly: a.active_only, limit: a.limit }),
);
tool("get_jobs_pending_analysis", "Active canonical jobs not yet scored for the current profile and scoring version (the analyze/score backlog).", { limit: z.number().int().optional(), source_key: z.string().optional() }, (a) => {
  const profile = getProfileRow(db);
  return searchJobs(db, { unscoredOnly: true, profileVersion: profile?.version, scoringVersion: config.matching.scoring_version, sourceKey: a.source_key, limit: a.limit ?? 50 });
});

// ───────────────────────────── runs / schedule ─────────────────────────────
tool(
  "create_search_run",
  "Start a pipeline run under the persistent lock. Scheduled/loop triggers only start when a schedule slot is due; manual (or force) always starts. Overlapping runs are skipped and recorded; interrupted runs are recovered first. Returns run, run_key, recovery actions.",
  { trigger: z.enum(["scheduled", "manual", "loop", "recovery"]), holder: z.string().describe("unique id of this session/process, e.g. claude-session-<id>"), force: z.boolean().optional() },
  (a) => startPipelineRun(db, config, { trigger: a.trigger, holder: a.holder, force: a.force }),
);
tool("heartbeat_search_run", "Extend the pipeline lock lease (call between long stages).", { holder: z.string() }, (a) => ({ extended: heartbeatPipeline(db, config, a.holder) }));
tool(
  "update_search_run",
  "Advance the run stage and/or add statistics (numeric stats are accumulated).",
  { run_id: z.number().int(), stage: z.enum(PIPELINE_STAGES).optional(), stats: z.record(z.string(), z.union([z.number(), z.string()])).optional(), note: z.string().nullable().optional() },
  (a) => {
    if (a.stage) updateRunStage(db, a.run_id, a.stage, a.note);
    if (a.stats) updateRunStats(db, a.run_id, a.stats);
    return getRun(db, a.run_id);
  },
);
tool(
  "complete_search_run",
  "Finish a run (completed | failed), store final stats and report path, persist the completed slot and release the lock.",
  { run_id: z.number().int(), holder: z.string(), status: z.enum(["completed", "failed"]), stats: z.record(z.string(), z.union([z.number(), z.string()])).optional(), report_path: z.string().nullable().optional(), notes: z.string().nullable().optional() },
  (a) => finishPipelineRun(db, { runId: a.run_id, holder: a.holder, status: a.status, stats: a.stats, reportPath: a.report_path, notes: a.notes }),
);
tool("get_search_run", "Get a run by id or run_key (or the latest run when neither is given), including errors and per-source results.", { run_id: z.number().int().optional(), run_key: z.string().optional() }, (a) => {
  const run = a.run_id ? getRun(db, a.run_id) : a.run_key ? getRunByKey(db, a.run_key) : (listRuns(db, { limit: 1 })[0] ?? null);
  if (!run) return null;
  return { ...getRun(db, run.id), source_results: getRunSourceResults(db, run.id) };
});
tool("list_search_runs", "List recent runs.", { status: z.enum(["running", "completed", "failed", "skipped", "interrupted"]).optional(), limit: z.number().int().optional() }, (a) => listRuns(db, { status: a.status, limit: a.limit }));
tool(
  "record_run_error",
  "Record an error (per source/operation) without stopping the run.",
  { run_id: z.number().int().nullable().optional(), source: z.string().nullable().optional(), operation: z.string(), error: z.string(), retry_count: z.number().int().optional(), recoverable: z.boolean().optional(), details: z.record(z.string(), json).nullable().optional() },
  (a) => recordRunError(db, { runId: a.run_id, source: a.source, operation: a.operation, error: a.error, retryCount: a.retry_count, recoverable: a.recoverable, details: a.details }),
);
tool(
  "record_source_result",
  "Record the outcome of querying one source in a run (upsert per run/source) and update the source's last run status.",
  {
    run_id: z.number().int(),
    source_key: z.string(),
    status: z.enum(["success", "failed", "blocked", "skipped", "partial"]),
    jobs_found: z.number().int().optional(),
    jobs_new: z.number().int().optional(),
    jobs_updated: z.number().int().optional(),
    jobs_deduplicated: z.number().int().optional(),
    error: z.string().nullable().optional(),
    retry_count: z.number().int().optional(),
    started_at: z.string().optional(),
  },
  (a) => {
    const source = requireSource(db, a.source_key);
    recordSourceResult(db, { runId: a.run_id, sourceId: source.id, status: a.status, jobsFound: a.jobs_found, jobsNew: a.jobs_new, jobsUpdated: a.jobs_updated, jobsDeduplicated: a.jobs_deduplicated, error: a.error, retryCount: a.retry_count, startedAt: a.started_at });
    db.prepare("UPDATE sources SET last_run_at = ?, last_success_at = CASE WHEN ? IN ('success','partial') THEN ? ELSE last_success_at END, last_error = ?, updated_at = ? WHERE id = ?").run(
      nowIso(), a.status, nowIso(), a.status === "success" ? null : (a.error ?? a.status), nowIso(), source.id,
    );
    return getRunSourceResults(db, a.run_id);
  },
);
tool("get_schedule_status", "Schedule state: last completed slot, next slot, whether a run is due now, lock holder and running runs.", {}, () => getScheduleStatus(db, config));
tool("get_system_state", "Read a persisted system state value.", { key: z.string() }, (a) => ({ key: a.key, value: getState<unknown>(db, a.key, null) }));
tool("set_system_state", "Persist a system state value (survives sessions).", { key: z.string(), value: json }, (a) => {
  setState(db, a.key, a.value);
  return { key: a.key, value: a.value };
});

// ───────────────────────────── applications ─────────────────────────────
tool(
  "record_application",
  "Get or create the single application record for a job (idempotent: a job can never have two applications). Refuses duplicate jobs.",
  { job_id: z.number().int(), run_id: z.number().int().nullable().optional(), initial_status: z.enum(["DISCOVERED", "MATCHED", "SELECTED"]).optional(), details: z.record(z.string(), json).nullable().optional() },
  (a) => getOrCreateApplication(db, { jobId: a.job_id, runId: a.run_id, initialStatus: a.initial_status, details: a.details }),
);
tool("get_application", "Get an application (by id or job id) with its full event history.", { application_id: z.number().int().optional(), job_id: z.number().int().optional() }, (a) => {
  if (a.application_id) return getApplication(db, a.application_id);
  if (a.job_id) return getApplicationByJob(db, a.job_id);
  throw new Error("application_id or job_id required");
});
tool(
  "update_application",
  "Patch application material and metadata (method, resume variant, cover letter path, answers, pending user questions, external reference). Status changes go through record_application_event.",
  {
    application_id: z.number().int(),
    method: z.enum(["api", "form", "email", "manual"]).nullable().optional(),
    resume_variant: z.string().nullable().optional(),
    cover_letter_path: z.string().nullable().optional(),
    answers: z.record(z.string(), json).nullable().optional(),
    requires_user_input: z.array(z.object({ question: z.string(), reason: z.string(), field: z.string().optional() })).nullable().optional(),
    external_reference: z.string().nullable().optional(),
    match_id: z.number().int().nullable().optional(),
    failure_reason: z.string().nullable().optional(),
    last_error: z.string().nullable().optional(),
    run_id: z.number().int().nullable().optional(),
  },
  (a) => {
    const { application_id, ...patch } = a;
    return updateApplication(db, application_id, patch);
  },
);
tool(
  "record_application_event",
  "Transition an application to a new state (validated against the state machine) and append the event. Use event_type to describe what happened (selected, prepared, submitted, api_error, user_declined, response_email, ...).",
  {
    application_id: z.number().int(),
    to_status: appState,
    event_type: z.string(),
    details: z.record(z.string(), json).nullable().optional(),
    run_id: z.number().int().nullable().optional(),
    external_reference: z.string().nullable().optional(),
    failure_reason: z.string().nullable().optional(),
  },
  (a) => transitionApplication(db, { applicationId: a.application_id, to: a.to_status, eventType: a.event_type, details: a.details, runId: a.run_id, externalReference: a.external_reference, failureReason: a.failure_reason }),
);
tool(
  "get_application_candidates",
  "Eligible jobs for this run grouped by source with the remaining per-source quota, ordered by the prioritization rules (score, compensation, seniority). By default only sources with automation_policy=apply_allowed; set include_discover_only=true to list manual-handoff candidates too.",
  { run_id: z.number().int(), source_key: z.string().optional(), include_discover_only: z.boolean().optional(), limit_per_source: z.number().int().optional() },
  (a) =>
    getApplicationCandidates(db, {
      runId: a.run_id,
      minimumScore: config.matching.minimum_score,
      maxPerSourcePerRun: config.applications.max_per_source_per_run,
      sourceKey: a.source_key,
      includeDiscoverOnly: a.include_discover_only,
      limitPerSource: a.limit_per_source,
    }),
);
tool(
  "check_can_submit",
  "Pre-flight before an automatic submission: not already submitted, job active, source allows automation, per-source per-run limit, score/eligibility, resume selected. Returns ok=false with reasons otherwise. Call immediately before transitioning to SUBMITTING.",
  { application_id: z.number().int(), run_id: z.number().int() },
  (a) =>
    assertCanSubmit(db, {
      applicationId: a.application_id,
      runId: a.run_id,
      maxPerSourcePerRun: config.applications.max_per_source_per_run,
      minimumScore: config.matching.minimum_score,
      automaticSubmission: config.applications.automatic_submission,
    }),
);
tool("list_applications", "List applications with filters.", { status: z.array(appState).optional(), source_key: z.string().optional(), run_id: z.number().int().optional(), since: z.string().optional(), limit: z.number().int().optional() }, (a) =>
  listApplications(db, { status: a.status, sourceKey: a.source_key, runId: a.run_id, since: a.since, limit: a.limit }),
);
tool("get_application_statistics", "Application counts by status and source plus the funnel (discovered -> relevant -> selected -> applied -> response -> interview -> offer -> accepted).", { since: z.string().optional(), period_days: z.number().int().optional() }, (a) =>
  getApplicationStatistics(db, { since: a.since ?? (a.period_days ? daysAgoIso(a.period_days) : undefined) }),
);
tool("mark_no_response", "Move SUBMITTED applications older than N days (default from config) to NO_RESPONSE for funnel statistics.", { older_than_days: z.number().int().optional(), run_id: z.number().int().nullable().optional() }, (a) => ({
  marked: markNoResponse(db, a.older_than_days ?? config.applications.no_response_after_days, a.run_id),
}));

// ───────────────────────────── company research ─────────────────────────────
tool(
  "record_company_research",
  "Store company research. Every finding carries evidence_level verified | inferred | unknown; verified findings must cite a source_url. Never store claims without evidence.",
  {
    company_id: z.number().int(),
    run_id: z.number().int().nullable().optional(),
    summary: z.string(),
    findings: z.array(
      z.object({
        topic: z.string(),
        claim: z.string(),
        evidence_level: z.enum(["verified", "inferred", "unknown"]),
        source_url: z.string().nullable().optional(),
        as_of: z.string().nullable().optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
      }),
    ),
    sources: z.array(z.string()).optional(),
    vault_note: z.string().nullable().optional(),
  },
  (a) => recordCompanyResearch(db, { companyId: a.company_id, runId: a.run_id, summary: a.summary, findings: a.findings, sources: a.sources, vaultNote: a.vault_note }),
);
tool("get_company_research", "Latest research for a company.", { company_id: z.number().int() }, (a) => getLatestCompanyResearch(db, a.company_id));
tool("get_companies_needing_research", "Companies behind the best eligible matches with missing or stale research (per config research.research_ttl_days / top_n_per_run).", { limit: z.number().int().optional() }, (a) =>
  getCompaniesNeedingResearch(db, { ttlDays: config.research.research_ttl_days, minScore: config.matching.minimum_score, limit: a.limit ?? config.research.top_n_per_run }),
);

// ───────────────────────────── market intelligence ─────────────────────────────
tool("get_source_statistics", "Per-source statistics: jobs discovered, relevant, applications, submissions, responses, errors, runs.", { since: z.string().optional(), period_days: z.number().int().optional() }, (a) =>
  getSourceStatistics(db, { since: a.since ?? (a.period_days ? daysAgoIso(a.period_days) : undefined) }),
);
tool(
  "get_market_statistics",
  "Market overview for a period: jobs by work mode/seniority/type/country, top skills with growth, compensation (explicit vs expected), per-source stats and the application funnel.",
  { period_days: z.number().int().optional().describe("default: market.snapshot_period_days"), period_start: z.string().optional(), period_end: z.string().optional(), currency: z.string().optional(), top_skills: z.number().int().optional() },
  (a) =>
    getMarketStatistics(db, {
      periodStart: a.period_start ?? daysAgoIso(a.period_days ?? config.market.snapshot_period_days),
      periodEnd: a.period_end,
      currency: a.currency,
      minSampleSize: config.market.min_sample_size,
      topSkills: a.top_skills,
    }),
);
tool("save_market_snapshot", "Persist a computed market snapshot for historical comparison.", { kind: z.enum(["skills", "compensation", "sources", "funnel", "summary"]), period_start: z.string(), period_end: z.string(), data: json, dimensions: z.record(z.string(), json).optional(), run_id: z.number().int().nullable().optional() }, (a) =>
  saveMarketSnapshot(db, { kind: a.kind, periodStart: a.period_start, periodEnd: a.period_end, data: a.data, dimensions: a.dimensions, runId: a.run_id }),
);
tool("get_market_snapshots", "List stored market snapshots.", { kind: z.enum(["skills", "compensation", "sources", "funnel", "summary"]).optional(), limit: z.number().int().optional() }, (a) => getMarketSnapshots(db, { kind: a.kind, limit: a.limit }));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("jobhunt-db MCP server started", { db: config.database.path, root: rootDir });
}

main().catch((err) => {
  logger.error("MCP server crashed", { error: errorToString(err) });
  process.stderr.write(`jobhunt-db MCP server failed: ${errorToString(err)}\n`);
  process.exit(1);
});
