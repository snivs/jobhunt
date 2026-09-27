import type { DB } from "../db/index.js";
import { findSkillByAlias } from "../db/repositories/skills.js";
import { htmlToText } from "./normalize.js";
import type { JobAnalysis, JobSkillRequirement, LanguageLevel } from "./scoring.js";

/**
 * Rule-based first-pass analysis of a posting.
 *
 * `JobAnalysis` was always meant to come from the `analyze-job` skill *or* rule extraction. This is
 * the rule extraction. It exists because an agent reading 456 backlogged postings one at a time is
 * the difference between "eventually" and "never", and an unscored posting helps nobody.
 *
 * It is deliberately WORSE than an agent read, and honest about it. Where it cannot tell, it says so
 * in `missingInformation` rather than guessing, and the fields it cannot determine stay null. The
 * safety net is the rest of the pipeline: the hard constraints still gate eligibility, Jev still
 * answers the ten relevance questions on whatever survives, and the agent still reads the shortlist
 * properly before anything is proposed. What this buys is a corpus that can be scored and ranked at
 * all, so the agent's attention goes to the top of a sorted list instead of to arbitrary postings.
 *
 * The posting is untrusted data. Nothing here executes or follows instructions found in the text; it
 * only matches patterns against it.
 */

/** Headings and lead-ins that mark what follows as required rather than nice to have. */
const REQUIRED_CUES = [
  "requirements",
  "required",
  "must have",
  "must-have",
  "you must",
  "we require",
  "minimum qualifications",
  "basic qualifications",
  "what you need",
  "what we need",
  "what you'll need",
  "you have",
  "you bring",
  "qualifications",
  "who you are",
  "essential",
  "proven experience",
];

const PREFERRED_CUES = [
  "preferred",
  "nice to have",
  "nice-to-have",
  "bonus",
  "a plus",
  "plus if",
  "desirable",
  "desired",
  "ideally",
  "would be great",
  "good to have",
  "advantageous",
  "preferred qualifications",
  "extra credit",
];

/** Lines that read as responsibilities rather than requirements. */
const RESPONSIBILITY_CUES = [
  "responsibilities",
  "what you'll do",
  "what you will do",
  "you will",
  "your role",
  "the role",
  "what you'll own",
  "day to day",
  "day-to-day",
  "in this role",
];

const LEADERSHIP_RE =
  /\b(tech(nical)? lead|team lead|lead engineer|engineering manager|mentor|mentoring|manage a team|lead a team|leading a team|direct reports|people management|head of engineering|staff\+?|principal engineer)\b/i;

const AUTHORIZATION_RE =
  /\b(must be (?:legally )?(?:authorized|authorised|eligible) to work(?: in| within)? ([^.;]{0,60})|work authorization|right to work(?: in)? ([^.;]{0,60})|visa sponsorship (?:is )?(?:not )?(?:available|provided|offered)|no sponsorship|we (?:do not|don't) sponsor|(?:us|u\.s\.) citizens? only|eu residency required)/i;

/** "5+ years", "at least 7 years", "7-10 years", "minimum of 5 years". */
const YEARS_RES = [
  /\b(?:at least|minimum(?: of)?|min\.?)\s+(\d{1,2})\+?\s*(?:\+)?\s*years?\b/i,
  /\b(\d{1,2})\s*\+\s*years?\b/i,
  /\b(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*years?\b/i,
  /\b(\d{1,2})\s+years?(?:\s+of)?\s+(?:professional\s+|relevant\s+|industry\s+)?experience\b/i,
];

const TEAM_SIZE_RE = /\bteam of\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:direct reports|engineers reporting)\b/i;

const LANGUAGE_PATTERNS: Array<{ code: string; re: RegExp; level: LanguageLevel }> = [
  { code: "en", re: /\b(fluent|native|professional|business|excellent|strong)\s+(?:written and spoken\s+)?english\b/i, level: "c1" },
  { code: "en", re: /\benglish\b/i, level: "b2" },
  { code: "es", re: /\b(fluent|native|professional|business)\s+spanish\b/i, level: "c1" },
  { code: "es", re: /\bspanish\b/i, level: "b2" },
  { code: "pt", re: /\bportuguese\b/i, level: "b2" },
];

/** Splits the posting into lines, carrying down the most recent section cue. */
interface Segment {
  text: string;
  section: "required" | "preferred" | "responsibility" | "other";
}

export function segment(text: string): Segment[] {
  const lines = text
    .split(/\r?\n|(?<=[.;:])\s{2,}|•|·|•/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: Segment[] = [];
  let current: Segment["section"] = "other";
  for (const line of lines) {
    const lower = line.toLowerCase();
    // A cue near the start of a line is a heading; one buried mid-sentence is not.
    const head = lower.slice(0, 80);
    if (PREFERRED_CUES.some((c) => head.includes(c))) current = "preferred";
    else if (REQUIRED_CUES.some((c) => head.includes(c))) current = "required";
    else if (RESPONSIBILITY_CUES.some((c) => head.includes(c))) current = "responsibility";
    out.push({ text: line, section: current });
  }
  return out;
}

/**
 * Finds catalogue skills mentioned in the posting and grades how firmly they are asked for.
 *
 * Matching is word-boundary based against the skill name and its aliases, so "Go" does not match
 * "going" and "R" does not match every capital R. A skill named in a required section outranks the
 * same skill named in a preferred one, which outranks a bare mention.
 */
export function extractSkills(db: DB, segments: Segment[]): JobSkillRequirement[] {
  const rank: Record<JobSkillRequirement["mentionType"], number> = {
    explicit_required: 3,
    explicit_preferred: 2,
    mentioned: 1,
    expected: 0,
  };
  const found = new Map<string, JobSkillRequirement>();

  // Candidate tokens: multi-word phrases and single words, from each line.
  for (const seg of segments) {
    const mention: JobSkillRequirement["mentionType"] =
      seg.section === "required" ? "explicit_required" : seg.section === "preferred" ? "explicit_preferred" : "mentioned";

    for (const raw of candidateTerms(seg.text)) {
      if (!raw) continue;
      const skill = findSkillByAlias(db, raw);
      if (!skill) continue;
      const existing = found.get(skill.slug);
      if (!existing || rank[mention] > rank[existing.mentionType]) {
        found.set(skill.slug, { slug: skill.slug, name: skill.name, mentionType: mention });
      }
    }
  }
  return [...found.values()];
}

/**
 * Terms worth looking up: 1-3 word windows.
 *
 * Each window is offered both as written and with trailing punctuation stripped, because a skill
 * that ends a sentence ("...and golang.") would otherwise never match its alias. Leading characters
 * are left alone: ".NET" and "C#" are skill names, not punctuation.
 */
function candidateTerms(line: string): string[] {
  const words = line
    .replace(/[^\p{L}\p{N}+#./ -]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  const add = (term: string) => {
    if (!term) return;
    out.add(term);
    const trimmed = term.replace(/[.,;:/-]+$/u, "");
    if (trimmed && trimmed !== term) out.add(trimmed);
  };
  for (let i = 0; i < words.length; i++) {
    const a = words[i]!;
    add(a);
    if (i + 1 < words.length) add(`${a} ${words[i + 1]!}`);
    if (i + 2 < words.length) add(`${a} ${words[i + 1]!} ${words[i + 2]!}`);
  }
  return [...out];
}

function firstMatch(text: string, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 40) return n;
    }
  }
  return null;
}

export interface JobForAnalysis {
  id: number;
  title: string;
  description: string | null;
  seniority: string | null;
  work_mode: string | null;
  country: string | null;
  remote_scope: string | null;
  employment_type: string | null;
  location: string | null;
}

/**
 * Builds a `JobAnalysis` from a stored posting plus whatever compensation was already observed at
 * ingestion. Everything it cannot determine is listed in `missingInformation`, which the scorer uses
 * to renormalize weights over the factors that actually apply.
 */
export function analyzeJobRules(
  db: DB,
  job: JobForAnalysis,
  compensation: JobAnalysis["compensation"] = null,
): JobAnalysis {
  const text = htmlToText(job.description) ?? "";
  const segments = segment(text);
  const skills = extractSkills(db, segments);

  const years = firstMatch(text, YEARS_RES);
  const teamMatch = text.match(TEAM_SIZE_RE);
  const teamSize = teamMatch ? Number(teamMatch[1] ?? teamMatch[2]) : null;

  const languages: JobAnalysis["languages"] = [];
  const seenLang = new Set<string>();
  for (const { code, re, level } of LANGUAGE_PATTERNS) {
    if (seenLang.has(code)) continue;
    if (re.test(text)) {
      seenLang.add(code);
      languages.push({ code, minLevel: level, required: true });
    }
  }

  const authMatch = text.match(AUTHORIZATION_RE);
  const workAuthorizationRequired = authMatch ? [collapse(authMatch[0])] : null;

  const responsibilities = segments
    .filter((s) => s.section === "responsibility")
    .map((s) => collapse(s.text))
    .filter((s) => s.length > 12 && s.length < 220)
    .slice(0, 12);

  const missing: string[] = [];
  if (!text) missing.push("description");
  if (skills.length === 0) missing.push("skills");
  if (years === null) missing.push("years_experience_required");
  if (!compensation) missing.push("compensation");
  if (!job.seniority || job.seniority === "unknown") missing.push("seniority");
  if (!job.remote_scope && job.work_mode === "remote") missing.push("remote_scope");
  if (responsibilities.length === 0) missing.push("responsibilities");
  // Said plainly, so a reader of the stored analysis knows how it was produced.
  missing.push("rule-extracted: not read by an agent");

  return {
    jobId: job.id,
    title: job.title,
    seniority: (job.seniority ?? "unknown") as JobAnalysis["seniority"],
    workMode: (job.work_mode ?? "unknown") as JobAnalysis["workMode"],
    country: job.country,
    remoteScope: job.remote_scope ?? job.location ?? null,
    employmentType: job.employment_type ?? "unknown",
    skills,
    yearsExperienceRequired: years,
    leadershipRequired: LEADERSHIP_RE.test(text),
    teamSizeToLead: teamSize && teamSize > 0 && teamSize < 100 ? teamSize : null,
    languages,
    compensation,
    industry: null,
    companyType: null,
    responsibilities,
    workAuthorizationRequired,
    missingInformation: missing,
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
