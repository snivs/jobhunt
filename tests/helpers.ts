import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type LoadedConfig } from "../src/config/index.js";
import { openDatabase, type DB } from "../src/db/index.js";
import { seedSkillAliases } from "../src/db/repositories/skills.js";
import { syncSources } from "../src/db/repositories/sources.js";
import type { RawJob } from "../src/core/normalize.js";
import type { CandidateProfile, JobAnalysis } from "../src/core/scoring.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function testConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  const cfg = loadConfig({ rootDir: ROOT, env: { JOBHUNT_DB_PATH: ":memory:" } });
  return { ...cfg, ...overrides };
}

export function testDb(): { db: DB; config: LoadedConfig } {
  const config = testConfig();
  const db = openDatabase({ dbPath: ":memory:" });
  syncSources(db, config.sources);
  seedSkillAliases(db);
  return { db, config };
}

export function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    sourceKey: "remotive",
    externalId: "ext-1",
    url: "https://remotive.com/remote-jobs/software-dev/senior-typescript-engineer-123?utm_source=x",
    title: "Senior TypeScript Engineer",
    companyName: "Acme Inc.",
    location: "Remote - LATAM",
    country: "Mexico",
    description: "<p>We need <b>TypeScript</b>, Node.js and AWS. 6+ years experience. Fully remote.</p>",
    postedAt: "2026-09-01T12:00:00Z",
    salary: { min: 90000, max: 120000, currency: "USD", period: "year", text: "USD 90k-120k" },
    ...overrides,
  };
}

export function sampleProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    version: 1,
    seniority: "senior",
    yearsExperience: 10,
    yearsLeadership: 4,
    skills: [
      { slug: "typescript", name: "TypeScript", level: "expert", years: 8 },
      { slug: "nodejs", name: "Node.js", level: "expert", years: 8 },
      { slug: "aws", name: "AWS", level: "advanced", years: 5 },
      { slug: "react", name: "React", level: "advanced", years: 5 },
      { slug: "postgresql", name: "PostgreSQL", level: "advanced", years: 6 },
    ],
    languages: [
      { code: "es", level: "native" },
      { code: "en", level: "c1" },
    ],
    location: { country: "Mexico", city: "Chihuahua", timezone: "America/Chihuahua" },
    workModes: ["remote"],
    acceptableCountries: ["Mexico"],
    relocation: false,
    compensation: { minimum: 80000, target: 110000, currency: "USD", period: "year" },
    industriesPreferred: ["fintech", "saas"],
    industriesAvoided: ["gambling"],
    responsibilitiesWanted: ["architecture", "mentoring"],
    responsibilitiesUnwanted: ["on-call 24/7"],
    companyTypesPreferred: ["product", "startup"],
    employmentTypes: ["full_time", "contract"],
    hardConstraints: [
      { type: "min_salary", amount: 80000, currency: "USD", period: "year" },
      { type: "work_mode", allowed: ["remote"] },
    ],
    ...overrides,
  };
}

export function sampleAnalysis(overrides: Partial<JobAnalysis> = {}): JobAnalysis {
  return {
    jobId: 1,
    title: "Senior TypeScript Engineer",
    seniority: "senior",
    workMode: "remote",
    country: "Mexico",
    remoteScope: "LATAM",
    employmentType: "full_time",
    skills: [
      { slug: "typescript", name: "TypeScript", mentionType: "explicit_required" },
      { slug: "nodejs", name: "Node.js", mentionType: "explicit_required" },
      { slug: "aws", name: "AWS", mentionType: "explicit_preferred" },
      { slug: "docker", name: "Docker", mentionType: "expected" },
    ],
    yearsExperienceRequired: 6,
    leadershipRequired: true,
    teamSizeToLead: 4,
    languages: [{ code: "en", minLevel: "b2", required: true }],
    compensation: { min: 90000, max: 120000, currency: "USD", period: "year", explicit: true },
    industry: "fintech",
    companyType: "startup",
    responsibilities: ["architecture", "mentoring", "code review"],
    workAuthorizationRequired: null,
    missingInformation: [],
    ...overrides,
  };
}
