import type { ScoringFactor, ScoringWeights } from "../config/index.js";
import { utcOffsetHours, type TimezoneWindow } from "./body-signals.js";
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
  /**
   * The candidate will not relocate: a job only qualifies if it can be performed from `country`.
   * Onsite/hybrid must be in `country`; remote must have a scope that reaches it. `acceptedScopes`
   * lists the extra scope words that include the candidate (region names, "global", "worldwide").
   */
  | { type: "workable_from"; country: string; acceptedScopes?: string[] }
  /** Reject a job whose responsibilities match any of these tags (e.g. support-only roles). */
  | { type: "excluded_responsibility"; tags: string[] }
  /**
   * Free-text rule the engine cannot evaluate. It never rejects a job silently: it is reported in
   * `manualChecks` so the agent knows it still has to verify the rule by hand.
   */
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
  /**
   * Phrases employers write for the work he actually does: specifying behaviour, building
   * evaluation harnesses, orchestrating agents. They live in the BODY of a posting, never its
   * title, which is why they are scored rather than searched.
   */
  practiceKeywords?: string[];
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
  /** Practice keywords found in the posting body. Optional: analyses stored before 2026-09-27 lack it. */
  practiceSignals?: string[];
  /** A time-zone window the posting demands, read from its body. Optional for the same reason. */
  timezoneWindow?: TimezoneWindow | null;
  /** Facts taken from the posting body that override the source's metadata, with their evidence. */
  bodyNotes?: string[];
  /**
   * Where the same employer posted the same role separately. Employers like Sezzle and Clara post
   * one copy per country; deduplication keeps one as canonical, and without this the Mexico copy
   * hid behind an Argentina or Colombia one and the role was rejected as unreachable.
   */
  alternateLocations?: string[];
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
  /** Hard constraints the engine cannot decide on its own and that a human still has to check. */
  manualChecks: string[];
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

/** ISO 3166 codes that sources send in place of country names (Lever sends "MX"). */
const COUNTRY_CODES: Record<string, string> = {
  mx: "mexico", mex: "mexico", us: "united states", usa: "united states", ca: "canada", br: "brazil", co: "colombia",
  ar: "argentina", cl: "chile", pe: "peru", uy: "uruguay", gb: "united kingdom", uk: "united kingdom", ie: "ireland",
  de: "germany", es: "spain", fr: "france", pt: "portugal", nl: "netherlands", pl: "poland", in: "india",
};

/** Lower-cased country name, whether the source gave a name ("Mexico", "México") or a code ("MX"). */
export function countryName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return COUNTRY_CODES[t] ?? t;
}

const GLOBAL_SCOPE_RE = /\b(worldwide|world|global|globally|anywhere)\b/i;

/**
 * Remote-work jargon that carries no geographic information. A scope built only out of these words
 * ("Remote", "Remote and async", "Remote (scope not stated)") tells us nothing about where the
 * employer can hire, so it must be treated as unstated rather than as a place that excludes us.
 */
const NON_GEOGRAPHIC_SCOPE_WORDS =
  /\b(remote|remotely|async|asynchronous|distributed|flexible|fully|full|part|time|first|team|work|working|from|home|office|scope|not|stated|unspecified|unknown|undisclosed|any|and|or|the|a|in|within|hybrid|onsite|on|site|n\/?a)\b/gi;

function scopeStatesGeography(scope: string): boolean {
  const remainder = scope
    .toLowerCase()
    .replace(NON_GEOGRAPHIC_SCOPE_WORDS, " ")
    .replace(/[^a-zà-ÿ]+/g, " ")
    .trim();
  return remainder.length > 0;
}

/** Does a free-text remote scope reach a candidate based in `country`? */
function scopeReaches(scope: string, country: string, acceptedScopes: string[]): boolean {
  const s = scope.toLowerCase();
  if (GLOBAL_SCOPE_RE.test(s)) return true;
  if (s.includes(country.toLowerCase())) return true;
  return acceptedScopes.some((a) => a.trim() !== "" && s.includes(a.toLowerCase()));
}

/**
 * A candidate who will not relocate can only take a job that reaches where he lives. Returns a
 * failure when the job clearly cannot, or a manual check when the posting does not say enough.
 */
function evaluateWorkableFrom(job: JobAnalysis, hc: Extract<HardConstraint, { type: "workable_from" }>): { failure?: string; manual?: string } {
  const base = hc.country;
  const baseLower = countryName(base)!;
  const accepted = hc.acceptedScopes ?? [];
  const jobCountry = countryName(job.country);
  // Another copy of the same posting placed in the candidate's country settles it either way.
  const alternates = job.alternateLocations ?? [];
  const fold = (x: string) => x.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const alternateHere = alternates.some((l) => !GLOBAL_SCOPE_RE.test(l) && scopeReaches(fold(l), baseLower, accepted.map(fold)));

  if (job.workMode === "onsite" || job.workMode === "hybrid") {
    if (alternateHere) return {};
    if (!jobCountry) return { manual: `${job.workMode} role with no country stated: confirm the workplace is in ${base}` };
    if (jobCountry !== baseLower) return { failure: `${job.workMode} in ${job.country}: would require relocating outside ${base}` };
    return {};
  }

  if (job.workMode === "remote") {
    if (alternateHere) return {};
    const scope = job.remoteScope?.trim();
    if (scope && scopeStatesGeography(scope)) {
      if (scopeReaches(scope, base, accepted)) return {};
      return { failure: `Remote scope "${scope}" does not reach ${base}` };
    }
    if (scope && scopeReaches(scope, base, accepted)) return {}; // e.g. "fully remote, anywhere"
    if (jobCountry && jobCountry !== baseLower) return { failure: `Remote but scoped to ${job.country}, not ${base}` };
    return { manual: `Remote role with no stated scope: confirm the employer can engage someone in ${base}` };
  }

  return { manual: `Work mode unknown: confirm the role can be performed from ${base}` };
}

function scoreLocation(profile: CandidateProfile, job: JobAnalysis): Partial {
  const modeOk = job.workMode === "unknown" || profile.workModes.includes(job.workMode);
  const countries = profile.acceptableCountries.map((c) => countryName(c)!);
  const jobCountry = countryName(job.country);
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

export type FxRates = Record<string, number>;

/** Converts an amount between currencies using FROM_TO (or the inverse TO_FROM) rates. Null when no rate is known. */
export function convertCurrency(amount: number, from: string, to: string, fxRates: FxRates = {}): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const direct = fxRates[`${f}_${t}`];
  if (direct) return amount * direct;
  const inverse = fxRates[`${t}_${f}`];
  if (inverse) return amount / inverse;
  return null;
}

function scoreCompensation(profile: CandidateProfile, job: JobAnalysis, undisclosedScore: number, fxRates: FxRates = {}): CompensationScore {
  const comp = job.compensation;
  if (!comp || (comp.min == null && comp.max == null)) {
    return { factor: "compensation_match", score: undisclosedScore, applicable: true, explanation: "Salary not disclosed", undisclosed: true, belowMinimum: false };
  }
  const jobCurrency = (comp.currency ?? profile.compensation.currency).toUpperCase();
  const myCurrency = profile.compensation.currency.toUpperCase();
  const kind = comp.explicit ? "Explicit" : "Expected";
  const rawMax = toAnnual(comp.max ?? comp.min ?? 0, comp.period);
  const rawMin = toAnnual(comp.min ?? comp.max ?? 0, comp.period);
  const convertedMax = convertCurrency(rawMax, jobCurrency, myCurrency, fxRates);
  const convertedMin = convertCurrency(rawMin, jobCurrency, myCurrency, fxRates);
  if (convertedMax == null || convertedMin == null) {
    return {
      factor: "compensation_match",
      score: 65,
      applicable: true,
      explanation: `${kind} range in ${jobCurrency}; candidate targets ${myCurrency} and no fx rate is configured, not compared automatically`,
      undisclosed: false,
      belowMinimum: false,
    };
  }
  const jobMaxAnnual = Math.round(convertedMax);
  const jobMinAnnual = Math.round(convertedMin);
  const currency = myCurrency;
  const converted = jobCurrency !== myCurrency ? ` (converted from ${rawMin.toLocaleString("en-US")}-${rawMax.toLocaleString("en-US")} ${jobCurrency}/year)` : "";
  const myMin = profile.compensation.minimum != null ? toAnnual(profile.compensation.minimum, profile.compensation.period) : null;
  const myTarget = profile.compensation.target != null ? toAnnual(profile.compensation.target, profile.compensation.period) : myMin;
  if (myMin != null && jobMaxAnnual < myMin) {
    return {
      factor: "compensation_match",
      score: 0,
      applicable: true,
      explanation: `${kind} max ${jobMaxAnnual.toLocaleString("en-US")} ${currency}/year below minimum ${myMin.toLocaleString("en-US")}${converted}`,
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
    explanation: `${kind} ${jobMinAnnual.toLocaleString("en-US")}-${jobMaxAnnual.toLocaleString("en-US")} ${currency}/year vs target ${myTarget.toLocaleString("en-US")}${converted}`,
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

/**
 * How much the posting describes the way the candidate actually works.
 *
 * He runs engineering processes: he specifies behaviour, writes tests and acceptance criteria, and
 * delegates implementation to agents. Employers who want that write it in the body of the posting -
 * "evaluation harness", "spec-driven development", "agent reliability", "human-in-the-loop" - while
 * the title stays something generic like Staff Engineer. Searching for these phrases finds almost
 * nothing, because they are not titles; scoring on them promotes the right postings out of a pile
 * of identically-titled ones.
 *
 * Deliberately NOT applicable when the posting mentions none of them. A posting that says nothing
 * about how the work is done is not evidence against the candidate, and scoring it zero would drag
 * down every ordinary architecture role. The weights renormalize over applicable factors, so an
 * absent signal simply does not vote.
 */
function scorePractice(profile: CandidateProfile, job: JobAnalysis): Partial {
  const wanted = profile.practiceKeywords ?? [];
  const found = job.practiceSignals ?? [];
  if (wanted.length === 0 || found.length === 0) {
    return { factor: "practice_match", score: 0, applicable: false, explanation: "No practice signals in the posting" };
  }
  // Three distinct phrases is already a posting written by someone who works this way; more than
  // that is the same signal repeated, so the curve flattens rather than rewarding keyword stuffing.
  const score = clamp(40 + Math.min(found.length, 3) * 20);
  return {
    factor: "practice_match",
    score,
    applicable: true,
    explanation: `Describes the candidate's way of working: ${found.slice(0, 5).join(", ")}`,
  };
}

function evaluateHardConstraints(
  profile: CandidateProfile,
  job: JobAnalysis,
  comp: CompensationScore,
): { failures: string[]; manualChecks: string[] } {
  const failures: string[] = [];
  const manualChecks: string[] = [];
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
        const jc = countryName(job.country);
        const allowed = hc.allowed.map((c) => countryName(c)!);
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
          // The analyzer stores the phrase it matched ("right to work in Mexico without sponsorship
          // now and in the future"), not a bare region, so a region the candidate holds counts when
          // the phrase names it.
          const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
          const regions = hc.regions.map(fold);
          const ok = job.workAuthorizationRequired.some((r) => {
            const phrase = fold(r);
            return regions.some((g) => phrase === g || new RegExp(`\\b${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(phrase));
          });
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
      case "workable_from": {
        const { failure, manual } = evaluateWorkableFrom(job, hc);
        if (failure) failures.push(failure);
        if (manual) manualChecks.push(manual);
        break;
      }
      case "excluded_responsibility": {
        const tags = hc.tags.map((t) => t.toLowerCase()).filter((t) => t !== "");
        const hit = job.responsibilities.find((r) => tags.some((t) => r.toLowerCase().includes(t)));
        if (hit) failures.push(`Responsibility the candidate excludes: "${hit}"`);
        break;
      }
      case "custom":
        // The engine cannot decide this one. Surface it instead of ignoring it silently.
        manualChecks.push(`Manual check required (${hc.key}): ${hc.description}`);
        break;
    }
  }
  return { failures, manualChecks };
}

/**
 * Rules that need no configuration because no candidate could meet them: a language the posting
 * requires and the candidate does not speak at all, and a time-zone window the posting enforces
 * that the candidate's own zone falls outside of. Both come from the posting body.
 */
const NON_ENGINEERING_TITLE =
  /\b(sales|partnerships?|marketing|recruit(?:er|ing)|talent acquisition|account (?:executive|manager)|customer success|business development|finance|accountant|accounting|legal|counsel|people partner|hr|human resources|comercial|ventas|mercadotecnia|contador|jur[ií]dico)\b/i;
const ENGINEERING_TITLE = /\b(engineer(?:ing)?|developer|architect|software|sre|devops|technical|tech lead|cto|ingenier[oa]|desarrollador(?:a)?)\b/i;

function evaluateBuiltInConstraints(profile: CandidateProfile, job: JobAnalysis): { failures: string[]; risks: string[] } {
  const failures: string[] = [];
  const risks: string[] = [];
  // A lead with years of experience does not take a junior or internship role, and seniority is
  // only one weighted factor, so without this "Developer Jr" topped the queue on 2026-09-27.
  if ((job.seniority === "junior" || job.seniority === "intern") && SENIORITY_RANK[profile.seniority] >= SENIORITY_RANK.senior) {
    failures.push(`${job.seniority === "intern" ? "Internship" : "Junior"} role for a ${profile.seniority} candidate`);
  }
  // Discovery terms such as "director" or "lead" also catch functions outside engineering.
  if (NON_ENGINEERING_TITLE.test(job.title) && !ENGINEERING_TITLE.test(job.title)) {
    failures.push(`Not an engineering role: "${job.title}"`);
  }
  for (const req of job.languages) {
    if (!req.required) continue;
    const mine = profile.languages.find((l) => l.code.toLowerCase() === req.code.toLowerCase());
    if (!mine) failures.push(`Requires ${req.code.toUpperCase()} at ${req.minLevel.toUpperCase()}; the candidate does not speak it`);
  }
  const tz = job.timezoneWindow;
  const home = profile.location.timezone;
  if (tz && home) {
    const offset = utcOffsetHours(home);
    // One hour of slack either side absorbs daylight saving on the employer's side.
    if (offset !== null && (offset < tz.baseOffset - tz.plusMinus - 1 || offset > tz.baseOffset + tz.plusMinus + 1)) {
      const msg = `Requires ${tz.zone} +/-${tz.plusMinus}h; ${home} is UTC${offset >= 0 ? "+" : ""}${offset} ("${tz.evidence}")`;
      (tz.hard ? failures : risks).push(msg);
    }
  }
  return { failures, risks };
}

export interface ScoringOptions {
  weights: ScoringWeights;
  minimumScore: number;
  undisclosedCompensationScore: number;
  scoringVersion: string;
  /** FROM_TO exchange rates (e.g. USD_MXN) used to compare salaries across currencies */
  fxRates?: FxRates;
}

/** Explainable, weighted scoring. Weights are renormalized over applicable factors. */
export function scoreJob(profile: CandidateProfile, job: JobAnalysis, options: ScoringOptions): MatchResult {
  const required = scoreRequiredSkills(profile, job);
  const comp = scoreCompensation(profile, job, options.undisclosedCompensationScore, options.fxRates ?? {});
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
    scorePractice(profile, job),
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

  const { failures: hardConstraintFailures, manualChecks } = evaluateHardConstraints(profile, job, comp);
  const builtIn = evaluateBuiltInConstraints(profile, job);
  hardConstraintFailures.push(...builtIn.failures);
  risks.push(...builtIn.risks);
  const eligible = hardConstraintFailures.length === 0 && overallScore >= options.minimumScore;
  for (const m of manualChecks) if (!missingInformation.includes(m)) missingInformation.push(m);

  return { overallScore, eligible, factors, strengths, risks, hardConstraintFailures, manualChecks, missingInformation, scoringVersion: options.scoringVersion };
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
  if (result.manualChecks.length) lines.push("", "Manual checks:", ...result.manualChecks.map((s) => `- ${s}`));
  if (result.missingInformation.length) lines.push("", `Missing information: ${result.missingInformation.join(", ")}`);
  return lines.join("\n");
}
