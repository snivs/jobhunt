import type { Seniority, WorkMode } from "../../core/normalize.js";
import type { CandidateLanguage, CandidateProfile, CandidateSkill, HardConstraint, SkillLevel } from "../../core/scoring.js";
import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";
import { ensureSkill, type SkillCategory } from "./skills.js";

export interface ProfileRow {
  id: number;
  full_name: string | null;
  headline: string | null;
  current_title: string | null;
  seniority: Seniority | null;
  years_experience: number | null;
  years_leadership: number | null;
  location: string | null;
  country: string | null;
  timezone: string | null;
  languages_json: string;
  work_authorization_json: string;
  vault_note: string | null;
  version: number;
  interview_completed: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileInput {
  full_name?: string | null;
  headline?: string | null;
  current_title?: string | null;
  seniority?: Seniority | null;
  years_experience?: number | null;
  years_leadership?: number | null;
  location?: string | null;
  country?: string | null;
  timezone?: string | null;
  languages?: CandidateLanguage[];
  work_authorization?: string[];
  vault_note?: string | null;
  interview_completed?: boolean;
}

export function getProfileRow(db: DB): ProfileRow | null {
  return (db.prepare("SELECT * FROM candidate_profile WHERE id = 1").get() as ProfileRow | undefined) ?? null;
}

/** Creates or patches the single candidate profile. Bumps version so existing matches are re-scored. */
export function upsertProfile(db: DB, input: ProfileInput): ProfileRow {
  const now = nowIso();
  const existing = getProfileRow(db);
  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(
        `INSERT INTO candidate_profile (id, full_name, headline, current_title, seniority, years_experience, years_leadership, location, country, timezone,
           languages_json, work_authorization_json, vault_note, version, interview_completed, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        input.full_name ?? null,
        input.headline ?? null,
        input.current_title ?? null,
        input.seniority ?? null,
        input.years_experience ?? null,
        input.years_leadership ?? null,
        input.location ?? null,
        input.country ?? null,
        input.timezone ?? null,
        toJson(input.languages ?? []),
        toJson(input.work_authorization ?? []),
        input.vault_note ?? null,
        input.interview_completed ? 1 : 0,
        now,
        now,
      );
      return;
    }
    const merged = {
      full_name: input.full_name !== undefined ? input.full_name : existing.full_name,
      headline: input.headline !== undefined ? input.headline : existing.headline,
      current_title: input.current_title !== undefined ? input.current_title : existing.current_title,
      seniority: input.seniority !== undefined ? input.seniority : existing.seniority,
      years_experience: input.years_experience !== undefined ? input.years_experience : existing.years_experience,
      years_leadership: input.years_leadership !== undefined ? input.years_leadership : existing.years_leadership,
      location: input.location !== undefined ? input.location : existing.location,
      country: input.country !== undefined ? input.country : existing.country,
      timezone: input.timezone !== undefined ? input.timezone : existing.timezone,
      languages_json: input.languages !== undefined ? toJson(input.languages) : existing.languages_json,
      work_authorization_json: input.work_authorization !== undefined ? toJson(input.work_authorization) : existing.work_authorization_json,
      vault_note: input.vault_note !== undefined ? input.vault_note : existing.vault_note,
      interview_completed: input.interview_completed !== undefined ? (input.interview_completed ? 1 : 0) : existing.interview_completed,
      version: existing.version + 1,
      updated_at: now,
    };
    db.prepare(
      `UPDATE candidate_profile SET full_name = @full_name, headline = @headline, current_title = @current_title, seniority = @seniority,
         years_experience = @years_experience, years_leadership = @years_leadership, location = @location, country = @country, timezone = @timezone,
         languages_json = @languages_json, work_authorization_json = @work_authorization_json, vault_note = @vault_note,
         interview_completed = @interview_completed, version = @version, updated_at = @updated_at WHERE id = 1`,
    ).run(merged);
  });
  tx();
  return getProfileRow(db)!;
}

function bumpVersion(db: DB): void {
  db.prepare("UPDATE candidate_profile SET version = version + 1, updated_at = ? WHERE id = 1").run(nowIso());
}

export interface CandidateSkillInput {
  skillName: string;
  category?: SkillCategory;
  level: SkillLevel;
  years?: number | null;
  isPrimary?: boolean;
  willingToLearn?: boolean;
  notes?: string | null;
}

export interface CandidateSkillRow {
  id: number;
  skill_id: number;
  level: SkillLevel;
  years: number | null;
  is_primary: number;
  willing_to_learn: number;
  notes: string | null;
  name: string;
  slug: string;
  category: SkillCategory;
}

export function setCandidateSkill(db: DB, input: CandidateSkillInput): CandidateSkillRow {
  if (!getProfileRow(db)) throw new Error("Create the candidate profile before adding skills");
  const now = nowIso();
  const tx = db.transaction(() => {
    const skill = ensureSkill(db, input.skillName, input.category);
    db.prepare(
      `INSERT INTO candidate_skills (skill_id, level, years, is_primary, willing_to_learn, notes, created_at, updated_at)
       VALUES (@skill_id, @level, @years, @is_primary, @willing_to_learn, @notes, @now, @now)
       ON CONFLICT(skill_id) DO UPDATE SET level = excluded.level, years = COALESCE(excluded.years, candidate_skills.years),
         is_primary = excluded.is_primary, willing_to_learn = excluded.willing_to_learn, notes = COALESCE(excluded.notes, candidate_skills.notes), updated_at = excluded.updated_at`,
    ).run({
      skill_id: skill.id,
      level: input.level,
      years: input.years ?? null,
      is_primary: input.isPrimary ? 1 : 0,
      willing_to_learn: input.willingToLearn === false ? 0 : 1,
      notes: input.notes ?? null,
      now,
    });
    bumpVersion(db);
    return db
      .prepare("SELECT cs.*, s.name, s.slug, s.category FROM candidate_skills cs JOIN skills s ON s.id = cs.skill_id WHERE cs.skill_id = ?")
      .get(skill.id) as CandidateSkillRow;
  });
  return tx();
}

export function removeCandidateSkill(db: DB, slug: string): boolean {
  const res = db.prepare("DELETE FROM candidate_skills WHERE skill_id IN (SELECT id FROM skills WHERE slug = ?)").run(slug);
  if (res.changes > 0) bumpVersion(db);
  return res.changes > 0;
}

export function listCandidateSkills(db: DB): CandidateSkillRow[] {
  return db
    .prepare("SELECT cs.*, s.name, s.slug, s.category FROM candidate_skills cs JOIN skills s ON s.id = cs.skill_id ORDER BY cs.is_primary DESC, s.name")
    .all() as CandidateSkillRow[];
}

export interface PreferenceRow {
  id: number;
  key: string;
  value_json: string;
  is_hard_constraint: number;
  source: string;
  created_at: string;
  updated_at: string;
}

/** Well-known preference keys read by buildScoringProfile. Other keys are stored and exposed but not scored. */
export const PREFERENCE_KEYS = [
  "work_modes", // WorkMode[]
  "acceptable_countries", // string[] ('*' = anywhere)
  "relocation", // boolean
  "travel", // string (none | occasional | frequent)
  "compensation", // { minimum, target, currency, period }
  "industries_preferred", // string[]
  "industries_avoided", // string[]
  "responsibilities_wanted", // string[]
  "responsibilities_unwanted", // string[]
  "company_types_preferred", // string[]
  "company_sizes_preferred", // string[]
  "employment_types", // string[]
  "target_titles", // string[]
  "hard_constraints", // HardConstraint[] (extra constraints not derivable from the keys above)
  "schedule", // { timezone, hours, flexibility }
  "auto_apply_allowed_fields", // string[] information that may be used automatically
  "requires_approval_fields", // string[]
  "resume_variants", // Array<{ name, path, use_for }>
  "standard_answers", // Record<string, string>
  "benefits_important", // string[]
] as const;

export function setPreference(db: DB, key: string, value: unknown, opts: { isHardConstraint?: boolean; source?: string } = {}): PreferenceRow {
  if (!getProfileRow(db)) throw new Error("Create the candidate profile before setting preferences");
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO candidate_preferences (key, value_json, is_hard_constraint, source, created_at, updated_at)
       VALUES (@key, @value_json, @hard, @source, @now, @now)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, is_hard_constraint = excluded.is_hard_constraint, source = excluded.source, updated_at = excluded.updated_at`,
    ).run({ key, value_json: toJson(value), hard: opts.isHardConstraint ? 1 : 0, source: opts.source ?? "interview", now });
    bumpVersion(db);
    return db.prepare("SELECT * FROM candidate_preferences WHERE key = ?").get(key) as PreferenceRow;
  });
  return tx();
}

export function getPreferences(db: DB): Record<string, { value: unknown; hard: boolean; source: string; updated_at: string }> {
  const out: Record<string, { value: unknown; hard: boolean; source: string; updated_at: string }> = {};
  for (const r of db.prepare("SELECT * FROM candidate_preferences ORDER BY key").all() as PreferenceRow[]) {
    out[r.key] = { value: fromJson<unknown>(r.value_json, null), hard: r.is_hard_constraint === 1, source: r.source, updated_at: r.updated_at };
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Assembles the scoring profile from SQLite. Returns null when no profile exists yet. */
export function buildScoringProfile(db: DB): CandidateProfile | null {
  const row = getProfileRow(db);
  if (!row) return null;
  const prefs = getPreferences(db);
  const get = (k: string): unknown => prefs[k]?.value;
  const isHard = (k: string): boolean => prefs[k]?.hard === true;

  const skills: CandidateSkill[] = listCandidateSkills(db).map((s) => ({
    slug: s.slug,
    name: s.name,
    level: s.level,
    years: s.years,
    isPrimary: s.is_primary === 1,
    willingToLearn: s.willing_to_learn === 1,
  }));

  const compRaw = (get("compensation") as { minimum?: number; target?: number; currency?: string; period?: "year" | "month" } | undefined) ?? {};
  const compensation = {
    minimum: compRaw.minimum ?? null,
    target: compRaw.target ?? null,
    currency: (compRaw.currency ?? "USD").toUpperCase(),
    period: compRaw.period ?? "year",
  };

  const workModes = asStringArray(get("work_modes")) as WorkMode[];
  const acceptableCountries = asStringArray(get("acceptable_countries"));
  const employmentTypes = asStringArray(get("employment_types"));

  const hardConstraints: HardConstraint[] = [];
  if (isHard("work_modes") && workModes.length) hardConstraints.push({ type: "work_mode", allowed: workModes });
  if (isHard("acceptable_countries") && acceptableCountries.length) hardConstraints.push({ type: "country", allowed: acceptableCountries, allowRemoteWorldwide: true });
  if (isHard("compensation") && compensation.minimum != null) {
    hardConstraints.push({ type: "min_salary", amount: compensation.minimum, currency: compensation.currency, period: compensation.period, applyWhenUndisclosed: false });
  }
  if (isHard("employment_types") && employmentTypes.length) hardConstraints.push({ type: "employment_type", allowed: employmentTypes });
  const extra = get("hard_constraints");
  if (Array.isArray(extra)) hardConstraints.push(...(extra as HardConstraint[]));

  return {
    version: row.version,
    seniority: row.seniority ?? "unknown",
    yearsExperience: row.years_experience ?? 0,
    yearsLeadership: row.years_leadership ?? 0,
    skills,
    languages: fromJson<CandidateLanguage[]>(row.languages_json, []),
    location: { country: row.country, city: row.location, timezone: row.timezone },
    workModes: workModes.length ? workModes : ["remote", "hybrid", "onsite"],
    acceptableCountries: acceptableCountries.length ? acceptableCountries : row.country ? [row.country] : ["*"],
    relocation: get("relocation") === true,
    compensation,
    industriesPreferred: asStringArray(get("industries_preferred")),
    industriesAvoided: asStringArray(get("industries_avoided")),
    responsibilitiesWanted: asStringArray(get("responsibilities_wanted")),
    responsibilitiesUnwanted: asStringArray(get("responsibilities_unwanted")),
    companyTypesPreferred: asStringArray(get("company_types_preferred")),
    employmentTypes,
    hardConstraints,
  };
}

/** Full profile payload for the agent (row + skills + preferences). */
export function getCandidateProfile(db: DB): { profile: ProfileRow; skills: CandidateSkillRow[]; preferences: ReturnType<typeof getPreferences>; scoring_profile: CandidateProfile } | null {
  const row = getProfileRow(db);
  if (!row) return null;
  return { profile: row, skills: listCandidateSkills(db), preferences: getPreferences(db), scoring_profile: buildScoringProfile(db)! };
}
