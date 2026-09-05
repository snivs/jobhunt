import type { ScoringFactor, ScoringWeights } from "../config/index.js";
import type { Seniority, WorkMode } from "./normalize.js";

export type SkillLevel = "expert" | "advanced" | "intermediate" | "basic" | "learning";
export type LanguageLevel = "native" | "c2" | "c1" | "b2" | "b1" | "a2" | "a1";

export interface CandidateSkill {
  slug: string;
  name: string;
  level: SkillLevel;
  years?: number | null;
  isPrimary?: boolean;
  willingToLearn?: boolean;
}

export interface CandidateLanguage {
  code: string;
  level: LanguageLevel;
}

export type HardConstraint =
  | { type: "min_salary"; amount: number; currency: string; period: "year" | "month"; applyWhenUndisclosed?: boolean }
  | { type: "work_mode"; allowed: WorkMode[] }
  | { type: "country"; allowed: string[]; allowRemoteWorldwide?: boolean }
  | { type: "language"; code: string; minLevel: LanguageLevel }
  | { type: "work_authorization"; regions: string[] }
  | { type: "required_skill"; slug: string }
  | { type: "employment_type"; allowed: string[] }
  | { type: "custom"; key: string; description: string };

/** Normalized candidate state used for scoring (built from SQLite, never from the vault directly). */
export interface CandidateProfile {
  version: number;
  seniority: Seniority;
  yearsExperience: number;
  yearsLeadership: number;
  skills: CandidateSkill[];
  languages: CandidateLanguage[];
  location: { country: string | null; city: string | null; timezone: string | null };
  workModes: WorkMode[];
  acceptableCountries: string[];
  relocation: boolean;
  compensation: { minimum: number | null; target: number | null; currency: string; period: "year" | "month" };
  industriesPreferred: string[];
  industriesAvoided: string[];
  responsibilitiesWanted: string[];
  responsibilitiesUnwanted: string[];
  companyTypesPreferred: string[];
  employmentTypes: string[];
  hardConstraints: HardConstraint[];
}

export interface JobSkillRequirement {
  slug: string;
  name: string;
  mentionType: "explicit_required" | "explicit_preferred" | "mentioned" | "expected";
  yearsRequired?: number | null;
}

export interface JobCompensation {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "year" | "month" | "hour" | "day" | "week" | null;
  explicit: boolean;
}

/** Structured analysis of a job (produced by the analyze-job skill or rule extraction). */
export interface JobAnalysis {
  jobId: number;
  title: string;
  seniority: Seniority;
  workMode: WorkMode;
  country: string | null;
  remoteScope: string | null;
  employmentType: string;
  skills: JobSkillRequirement[];
  yearsExperienceRequired: number | null;
  leadershipRequired: boolean;
  teamSizeToLead: number | null;
  languages: Array<{ code: string; minLevel: LanguageLevel; required: boolean }>;
  compensation: JobCompensation | null;
  industry: string | null;
  companyType: string | null;
  responsibilities: string[];
  workAuthorizationRequired: string[] | null;
  missingInformation: string[];
}

export interface FactorScore {
  factor: ScoringFactor;
  score: number;
  weight: number;
  applicable: boolean;
  explanation: string;
}

export interface MatchResult {
  overallScore: number;
  eligible: boolean;
  factors: FactorScore[];
  strengths: string[];
  risks: string[];
  hardConstraintFailures: string[];
  missingInformation: string[];
  scoringVersion: string;
}

const SENIORITY_RANK: Record<Seniority, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  staff: 4,
  lead: 4,
  principal: 5,
  manager: 4,
  director: 6,
  executive: 7,
  unknown: -1,
};

const LEVEL_RANK: Record<SkillLevel, number> = { expert: 1.0, advanced: 0.85, intermediate: 0.65, basic: 0.4, learning: 0.2 };
const LANG_RANK: Record<LanguageLevel, number> = { native: 7, c2: 6, c1: 5, b2: 4, b1: 3, a2: 2, a1: 1 };
const ANNUAL_MULTIPLIER: Record<string, number> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export function toAnnual(amount: number, period: string | null | undefined): number {
  return amount * (ANNUAL_MULTIPLIER[period ?? "year"] ?? 1);
}

function skillMap(profile: CandidateProfile): Map<string, CandidateSkill> {
  return new Map(profile.skills.map((s) => [s.slug, s]));
}

type Partial = Omit<FactorScore, "weight">;

function scoreRequiredSkills(profile: CandidateProfile, job: JobAnalysis): Partial & { matched: string[]; missing: string[] } {
  const required = job.skills.filter((s) => s.mentionType === "explicit_required");
  const mine = skillMap(profile);
  if (required.length === 0) {
    return { factor: "required_skill_match", score: 0, applicable: false, explanation: "No explicit required skills listed", matched: [], missing: [] };
  }
  let total = 0;
  const matched: string[] = [];
  const missing: string[] = [];
  for (const r of required) {
    const s = mine.get(r.slug);
    if (s) {
      let v = LEVEL_RANK[s.level];
      if (r.yearsRequired && s.years != null && s.years < r.yearsRequired) v *= 0.8;
      total += v;
      matched.push(r.name);
    } else {
      missing.push(r.name);
    }
  }
  const score = clamp((total / required.length) * 100);
  return {
    factor: "required_skill_match",
    score,
    applicable: true,
    explanation: `${matched.length}/${required.length} required skills covered${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    matched,
    missing,
  };
}

function scoreTechnical(profile: CandidateProfile, job: JobAnalysis): Partial {
  const mine = skillMap(profile);
  const weights: Record<JobSkillRequirement["mentionType"], number> = {
    explicit_required: 1.0,
    explicit_preferred: 0.6,
    mentioned: 0.3,
    expected: 0.4,
  };
  let total = 0;
  let got = 0;
  for (const s of job.skills) {
    const w = weights[s.mentionType];
    total += w;
    const m = mine.get(s.slug);
    if (m) got += w * LEVEL_RANK[m.level];
  }
  if (total === 0) return { factor: "technical_match", score: 0, applicable: false, explanation: "No skills identified in the posting" };
  const score = clamp((got / total) * 100);
  return { factor: "technical_match", score, applicable: true, explanation: `Weighted coverage of ${job.skills.length} skills: ${score.toFixed(0)}%` };
}

function scoreExperience(profile: CandidateProfile, job: JobAnalysis): Partial {
  if (job.yearsExperienceRequired == null) {
    return { factor: "experience_match", score: 0, applicable: false, explanation: "Years of experience not specified" };
  }
  const ratio = profile.yearsExperience / Math.max(job.yearsExperienceRequired, 1);
  const score = ratio >= 1 ? 100 : clamp(ratio * 90);
  return { factor: "experience_match", score, applicable: true, explanation: `${profile.yearsExperience} years vs ${job.yearsExperienceRequired} required` };
}

function scoreSeniority(profile: CandidateProfile, job: JobAnalysis): Partial {
  if (job.seniority === "unknown" || profile.seniority === "unknown") {
    return { factor: "seniority_match", score: 0, applicable: false, explanation: "Seniority unknown" };
  }
  const diff = SENIORITY_RANK[job.seniority] - SENIORITY_RANK[profile.seniority];
  let score: number;
  if (diff === 0) score = 100;
  else if (diff === -1) score = 75; // slightly below the candidate's level
  else if (diff === 1) score = 85; // a step up
  else if (diff <= -2) score = 40; // overqualified
  else score = 45; // too big a jump
  return { factor: "seniority_match", score, applicable: true, explanation: `Job ${job.seniority} vs candidate ${profile.seniority}` };
}

function scoreLeadership(profile: CandidateProfile, job: JobAnalysis): Partial {
  if (!job.leadershipRequired) {
    return { factor: "leadership_match", score: 0, applicable: false, explanation: "Leadership not required" };
  }
  const y = profile.yearsLeadership;
  const score = y >= 5 ? 100 : y >= 2 ? 85 : y > 0 ? 60 : 25;
  return { factor: "leadership_match", score, applicable: true, explanation: `${y} years leading teams` };
}

function isWorldwideRemote(job: JobAnalysis): boolean {
  return job.workMode === "remote" && (!job.remoteScope || /world|global|anywhere/i.test(job.remoteScope));
}

function scoreLocation(profile: CandidateProfile, job: JobAnalysis): Partial {
  const modeOk = job.workMode === "unknown" || profile.workModes.includes(job.workMode);
  const countries = profile.acceptableCountries.map((c) => c.toLowerCase());
  const jobCountry = job.country?.toLowerCase() ?? null;
  const countryOk = jobCountry ? countries.includes(jobCountry) || countries.includes("*") : false;
  let score: number;
  let explanation: string;
  if (job.workMode === "remote") {
    if (isWorldwideRemote(job)) {
      score = 100;
      explanation = "Remote worldwide";
    } else if (countryOk) {
      score = 100;
      explanation = `Remote within ${job.country}`;
    } else if (jobCountry) {
      score = 30;
      explanation = `Remote restricted to ${job.country}${job.remoteScope ? ` (${job.remoteScope})` : ""}`;
    } else {
      score = 80;
      explanation = "Remote, scope unclear";
    }
  } else if (job.workMode === "unknown") {
    score = 60;
    explanation = "Work mode unknown";
  } else if (modeOk && countryOk) {
    score = 100;
    explanation = `${job.workMode} in an acceptable country`;
  } else if (modeOk && profile.relocation) {
    score = 60;
    explanation = `${job.workMode} elsewhere, relocation possible`;
  } else {
    score = 10;
    explanation = `${job.workMode}${job.country ? ` in ${job.country}` : ""} not acceptable`;
  }
  if (!modeOk) score = Math.min(score, 10);
  return { factor: "location_match", score, applicable: true, explanation };
}

function scoreLanguage(profile: CandidateProfile, job: JobAnalysis): Partial {
  if (job.languages.length === 0) return { factor: "language_match", score: 0, applicable: false, explanation: "No language requirement stated" };
  let score = 100;
  const notes: string[] = [];
  for (const req of job.languages) {
    const mine = profile.languages.find((l) => l.code.toLowerCase() === req.code.toLowerCase());
    const have = mine ? LANG_RANK[mine.level] : 0;
    const need = LANG_RANK[req.minLevel];
    if (have >= need) continue;
    const penalty = req.required ? (have === 0 ? 100 : 50) : 20;
    score = Math.min(score, 100 - penalty);
    notes.push(`${req.code.toUpperCase()} ${req.minLevel} required, have ${mine?.level ?? "none"}`);
  }
  return { factor: "language_match", score: clamp(score), applicable: true, explanation: notes.length ? notes.join("; ") : "All language requirements met" };
}

interface CompensationScore extends Partial {
  undisclosed: boolean;
  belowMinimum: boolean;
}

function scoreCompensation(profile: CandidateProfile, job: JobAnalysis, undisclosedScore: number): CompensationScore {
  const comp = job.compensation;
  if (!comp || (comp.min == null && comp.max == null)) {
    return { factor: "compensation_match", score: undisclosedScore, applicable: true, explanation: "Salary not disclosed", undisclosed: true, belowMinimum: false };
  }
  const currency = (comp.currency ?? profile.compensation.currency).toUpperCase();
  const sameCurrency = currency === profile.compensation.currency.toUpperCase();
  const jobMaxAnnual = toAnnual(comp.max ?? comp.min ?? 0, comp.period);
  const jobMinAnnual = toAnnual(comp.min ?? comp.max ?? 0, comp.period);
  const myMin = profile.compensation.minimum != null ? toAnnual(profile.compensation.minimum, profile.compensation.period) : null;
  const myTarget = profile.compensation.target != null ? toAnnual(profile.compensation.target, profile.compensation.period) : myMin;
  const kind = comp.explicit ? "Explicit" : "Expected";
  if (!sameCurrency) {
    return {
      factor: "compensation_match",
      score: 65,
      applicable: true,
      explanation: `${kind} range in ${currency}; candidate targets ${profile.compensation.currency}, not compared automatically`,
      undisclosed: false,
      belowMinimum: false,
    };
  }
  if (myMin != null && jobMaxAnnual < myMin) {
    return {
      factor: "compensation_match",
      score: 0,
      applicable: true,
      explanation: `${kind} max ${jobMaxAnnual.toLocaleString("en-US")} ${currency}/year below minimum ${myMin.toLocaleString("en-US")}`,
      undisclosed: false,
      belowMinimum: true,
    };
  }
  if (myTarget == null) {
    return { factor: "compensation_match", score: 80, applicable: true, explanation: "Candidate has no salary target configured", undisclosed: false, belowMinimum: false };
  }
  let score: number;
  if (jobMaxAnnual >= myTarget) score = jobMinAnnual >= myTarget ? 100 : 90;
  else if (myMin != null) score = clamp(50 + ((jobMaxAnnual - myMin) / Math.max(myTarget - myMin, 1)) * 40);
  else score = clamp((jobMaxAnnual / myTarget) * 80);
  return {
    factor: "compensation_match",
    score,
    applicable: true,
    explanation: `${kind} ${jobMinAnnual.toLocaleString("en-US")}-${jobMaxAnnual.toLocaleString("en-US")} ${currency}/year vs target ${myTarget.toLocaleString("en-US")}`,
    undisclosed: false,
    belowMinimum: false,
  };
}

function listOverlap(a: string[], b: string[]): number {
  const bs = new Set(b.map((x) => x.toLowerCase()));
  return a.filter((x) => bs.has(x.toLowerCase())).length;
}

function scoreIndustry(profile: CandidateProfile, job: JobAnalysis): Partial {
  if (!job.industry) return { factor: "industry_match", score: 0, applicable: false, explanation: "Industry unknown" };
  const ind = job.industry.toLowerCase();
  if (profile.industriesAvoided.some((i) => ind.includes(i.toLowerCase()))) {
    return { factor: "industry_match", score: 10, applicable: true, explanation: `Industry ${job.industry} is on the avoid list` };
  }
  if (profile.industriesPreferred.length === 0) return { factor: "industry_match", score: 80, applicable: true, explanation: `Industry ${job.industry}, no preference set` };
  if (profile.industriesPreferred.some((i) => ind.includes(i.toLowerCase()))) {
    return { factor: "industry_match", score: 100, applicable: true, explanation: `Preferred industry ${job.industry}` };
  }
  return { factor: "industry_match", score: 60, applicable: true, explanation: `Industry ${job.industry} not among preferences` };
}

function scoreResponsibilities(profile: CandidateProfile, job: JobAnalysis): Partial {
  if (job.responsibilities.length === 0) return { factor: "responsibility_match", score: 0, applicable: false, explanation: "Responsibilities not extracted" };
  const wanted = listOverlap(job.responsibilities, profile.responsibilitiesWanted);
  const unwanted = listOverlap(job.responsibilities, profile.responsibilitiesUnwanted);
  let score = 70 + wanted * 10 - unwanted * 25;
  if (profile.responsibilitiesWanted.length === 0 && profile.responsibilitiesUnwanted.length === 0) score = 75;
  return { factor: "responsibility_match", score: clamp(score), applicable: true, explanation: `${wanted} wanted / ${unwanted} unwanted responsibility tags matched` };
}

function scorePreference(profile: CandidateProfile, job: JobAnalysis): Partial {
  let score = 75;
  const notes: string[] = [];
  if (job.companyType && profile.companyTypesPreferred.length > 0) {
    const ct = job.companyType.toLowerCase();
    if (profile.companyTypesPreferred.some((t) => ct.includes(t.toLowerCase()))) {
      score += 20;
      notes.push(`preferred company type ${job.companyType}`);
    } else {
      score -= 15;
      notes.push(`company type ${job.companyType} not preferred`);
    }
  }
  if (profile.employmentTypes.length > 0 && job.employmentType !== "unknown") {
    if (profile.employmentTypes.includes(job.employmentType)) notes.push(`employment type ${job.employmentType} ok`);
    else {
      score -= 40;
      notes.push(`employment type ${job.employmentType} not wanted`);
    }
  }
  return { factor: "preference_match", score: clamp(score), applicable: true, explanation: notes.length ? notes.join("; ") : "No specific preference signals" };
}

function evaluateHardConstraints(profile: CandidateProfile, job: JobAnalysis, comp: CompensationScore): string[] {
  const failures: string[] = [];
  for (const hc of profile.hardConstraints) {
    switch (hc.type) {
      case "min_salary": {
        if (comp.belowMinimum) failures.push(`Salary below minimum (${hc.amount.toLocaleString("en-US")} ${hc.currency}/${hc.period})`);
        else if (comp.undisclosed && hc.applyWhenUndisclosed) failures.push("Salary not disclosed and minimum salary is a hard constraint");
        break;
      }
      case "work_mode": {
        if (job.workMode !== "unknown" && !hc.allowed.includes(job.workMode)) {
          failures.push(`Work mode ${job.workMode} not allowed (allowed: ${hc.allowed.join(", ")})`);
        }
        break;
      }
      case "country": {
        const jc = job.country?.toLowerCase();
        const allowed = hc.allowed.map((c) => c.toLowerCase());
        if (isWorldwideRemote(job) && hc.allowRemoteWorldwide !== false) break;
        if (jc && !allowed.includes(jc) && !allowed.includes("*")) failures.push(`Country ${job.country} not allowed`);
        break;
      }
      case "language": {
        const req = job.languages.find((l) => l.code.toLowerCase() === hc.code.toLowerCase() && l.required);
        if (req) {
          const mine = profile.languages.find((l) => l.code.toLowerCase() === hc.code.toLowerCase());
          if (!mine || LANG_RANK[mine.level] < LANG_RANK[req.minLevel]) failures.push(`Required language ${hc.code} ${req.minLevel} not met`);
        }
        break;
      }
      case "work_authorization": {
        if (job.workAuthorizationRequired && job.workAuthorizationRequired.length > 0) {
          const regions = hc.regions.map((x) => x.toLowerCase());
          const ok = job.workAuthorizationRequired.some((r) => regions.includes(r.toLowerCase()));
          if (!ok) failures.push(`Work authorization required for ${job.workAuthorizationRequired.join("/")}`);
        }
        break;
      }
      case "required_skill": {
        if (!job.skills.some((s) => s.slug === hc.slug)) failures.push(`Job does not involve essential technology ${hc.slug}`);
        break;
      }
      case "employment_type": {
        if (job.employmentType !== "unknown" && !hc.allowed.includes(job.employmentType)) failures.push(`Employment type ${job.employmentType} not allowed`);
        break;
      }
      case "custom":
        break;
    }
  }
  return failures;
}

export interface ScoringOptions {
  weights: ScoringWeights;
  minimumScore: number;
  undisclosedCompensationScore: number;
  scoringVersion: string;
}

/** Explainable, weighted scoring. Weights are renormalized over applicable factors. */
export function scoreJob(profile: CandidateProfile, job: JobAnalysis, options: ScoringOptions): MatchResult {
  const required = scoreRequiredSkills(profile, job);
  const comp = scoreCompensation(profile, job, options.undisclosedCompensationScore);
  const partials: Partial[] = [
    scoreTechnical(profile, job),
    required,
    scoreExperience(profile, job),
    scoreSeniority(profile, job),
    scoreLeadership(profile, job),
    scoreLocation(profile, job),
    scoreLanguage(profile, job),
    comp,
    scoreIndustry(profile, job),
    scoreResponsibilities(profile, job),
    scorePreference(profile, job),
  ];
  const factors: FactorScore[] = partials.map((f) => ({
    factor: f.factor,
    score: Math.round(f.score),
    applicable: f.applicable,
    explanation: f.explanation,
    weight: options.weights[f.factor],
  }));

  const applicable = factors.filter((f) => f.applicable && f.weight > 0);
  const totalWeight = applicable.reduce((a, f) => a + f.weight, 0);
  const overall = totalWeight > 0 ? applicable.reduce((a, f) => a + f.score * f.weight, 0) / totalWeight : 0;
  const overallScore = Math.round(overall * 10) / 10;

  const strengths: string[] = [];
  const risks: string[] = [];
  strengths.push(...required.matched.map((s) => `Required skill: ${s}`));
  risks.push(...required.missing.map((s) => `Missing required skill: ${s}`));
  for (const f of factors) {
    if (!f.applicable || f.factor === "required_skill_match") continue;
    const label = f.factor.replace(/_/g, " ");
    if (f.score >= 90) strengths.push(`${label}: ${f.explanation}`);
    if (f.score <= 50) risks.push(`${label}: ${f.explanation}`);
  }
  if (comp.undisclosed) risks.push("Salary not disclosed");
  const missingInformation = [...job.missingInformation];
  if (comp.undisclosed && !missingInformation.includes("compensation")) missingInformation.push("compensation");
  if (job.seniority === "unknown" && !missingInformation.includes("seniority")) missingInformation.push("seniority");
  if (job.workMode === "unknown" && !missingInformation.includes("work_mode")) missingInformation.push("work_mode");

  const hardConstraintFailures = evaluateHardConstraints(profile, job, comp);
  const eligible = hardConstraintFailures.length === 0 && overallScore >= options.minimumScore;

  return { overallScore, eligible, factors, strengths, risks, hardConstraintFailures, missingInformation, scoringVersion: options.scoringVersion };
}

/** Human-readable explanation block (used in reports and the vault). */
export function explainMatch(result: MatchResult): string {
  const lines = [`Overall: ${result.overallScore}/100 (${result.eligible ? "eligible" : "not eligible"})`, ""];
  for (const f of result.factors) {
    lines.push(`${f.factor.replace(/_/g, " ")}: ${f.applicable ? f.score : "n/a"} - ${f.explanation}`);
  }
  if (result.strengths.length) lines.push("", "Strengths:", ...result.strengths.map((s) => `- ${s}`));
  if (result.risks.length) lines.push("", "Risks:", ...result.risks.map((s) => `- ${s}`));
  if (result.hardConstraintFailures.length) lines.push("", "Hard constraint failures:", ...result.hardConstraintFailures.map((s) => `- ${s}`));
  if (result.missingInformation.length) lines.push("", `Missing information: ${result.missingInformation.join(", ")}`);
  return lines.join("\n");
}
