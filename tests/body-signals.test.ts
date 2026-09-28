import { describe, expect, it } from "vitest";
import { analyzeJobRules, extractLanguages, segment, type JobForAnalysis } from "../src/core/analyze.js";
import { extractBodySignals, extractSalary, extractScope, extractTimezone, utcOffsetHours } from "../src/core/body-signals.js";
import { scoreJob, type ScoringOptions } from "../src/core/scoring.js";
import { sampleProfile, testDb } from "./helpers.js";

// Every sentence below is quoted from a posting in the corpus on 2026-09-27. Each one was read by
// the aggregator as "remote, worldwide, salary not disclosed" and each one says otherwise.

function job(description: string, over: Partial<JobForAnalysis> = {}): JobForAnalysis {
  return {
    id: 1,
    title: "Senior Engineer",
    description,
    seniority: "senior",
    work_mode: "remote",
    country: null,
    remote_scope: "Anywhere in the World",
    employment_type: "full_time",
    location: "Anywhere in the World",
    ...over,
  };
}

const OPTIONS: ScoringOptions = {
  weights: {
    technical_match: 0.18, required_skill_match: 0.14, experience_match: 0.1, seniority_match: 0.1,
    leadership_match: 0.06, location_match: 0.1, language_match: 0.05, compensation_match: 0.1,
    industry_match: 0.04, responsibility_match: 0.08, preference_match: 0.05, practice_match: 0.06,
  },
  minimumScore: 0,
  undisclosedCompensationScore: 60,
  scoringVersion: "test",
};

describe("geography the employer states in the body", () => {
  it("reads a province restriction under an aggregator's 'Anywhere in the World' (Faire)", () => {
    const s = extractScope("Note: This role can also be performed remotely for candidates located in Ontario, Canada.");
    expect(s?.text).toBe("Ontario, Canada");
  });

  it("reads 'Location: Remote Ireland' (Huntress)", () => {
    expect(extractScope("Reports to: Director\nLocation: Remote Ireland\nCompensation Range: €115,200 to €133,000")?.text).toBe("Ireland");
  });

  it("reads 'remote work arrangement within the US' (Princeton)", () => {
    expect(extractScope("A remote work arrangement within the US may be considered for candidates.")?.text).toBe("US");
  });

  it.each([
    ["Product Genius | Backend Engineer | REMOTE (US) | Full-time | $165k–$190k + equity", "US"],
    ["Proof of eligibility to work in the United States is required.", "United States"],
    // The narrower of the two statements wins; both exclude Mexico.
    ["Headquarters: Remote, Canada\n** Open to remote within the East Coast only** At JFrog", "East Coast"],
    ["Headquarters: Remote, United States\nAt Squarespace, we empower our product teams", "United States"],
    ["Headquarters: Remote, Ontario, Canada\nAbout CircleCI Engineering", "Ontario, Canada"],
  ])("reads the restriction in %s", (text, place) => {
    expect(extractScope(text)?.text).toBe(place);
  });

  it("does not read a head office or a bare 'Remote' as a restriction", () => {
    // Tiugo's header named its head office; the role was anywhere. Discord's said only "Remote".
    expect(extractScope("Headquarters: Warsaw, 14, Poland\nWe are the company behind CKEditor")).toBeNull();
    expect(extractScope("Headquarters: Remote\n\nDiscord has a highly engaged community of millions")).toBeNull();
    expect(extractScope("Location: Remote\nCompensation Range: €115,200 to €133,000")).toBeNull();
  });

  it("marks a pay range stated for one country as a manual check", () => {
    const { db } = testDb();
    const a = analyzeJobRules(db, job("For the entry level position, our compensation for US based candidates, lies between 48,000 USD to 70,000 USD."));
    expect(a.missingInformation.some((m) => m.startsWith("Published pay is stated for one country"))).toBe(true);
  });

  it("ignores phrases that name no place, and scopes that are global", () => {
    expect(extractScope("Candidates must be located in a quiet place with good internet.")).toBeNull();
    expect(extractScope("This role can be performed remotely for candidates located anywhere in the world.")).toBeNull();
  });

  it("rejects the job for a candidate who cannot work from there", () => {
    const { db } = testDb();
    const analysis = analyzeJobRules(db, job("About the role.\nThis role can also be performed remotely for candidates located in Ontario, Canada."));
    expect(analysis.remoteScope).toBe("Ontario, Canada");
    expect(analysis.bodyNotes?.[0]).toContain("Ontario");
    const profile = sampleProfile({ hardConstraints: [{ type: "workable_from", country: "Mexico", acceptedScopes: ["latam", "americas"] }] });
    const result = scoreJob(profile, analysis, OPTIONS);
    expect(result.eligible).toBe(false);
    expect(result.hardConstraintFailures.join(" ")).toContain("Ontario, Canada");
  });

  it("keeps a scope that does include the candidate (KoboToolbox)", () => {
    const { db } = testDb();
    const analysis = analyzeJobRules(db, job("We hire remotely.", { remote_scope: "USA, Canada, Argentina, Mexico, Peru" }));
    const profile = sampleProfile({ hardConstraints: [{ type: "workable_from", country: "Mexico" }] });
    expect(scoreJob(profile, analysis, OPTIONS).hardConstraintFailures).toEqual([]);
  });

  it("turns 'any country where we have a legal entity' into a manual check, not a rejection (Atlassian)", () => {
    const { db } = testDb();
    const analysis = analyzeJobRules(db, job("We can hire people in any country where we have a legal entity. Interviews are virtual."));
    expect(analysis.missingInformation.some((m) => m.includes("legal entity"))).toBe(true);
    expect(analysis.remoteScope).toBe("Anywhere in the World");
  });

  it("flags in-office days as a manual check", () => {
    const signals = extractBodySignals("Hybrid employees currently go into the office 3 days per week on Tuesdays and Thursdays.");
    expect(signals.officeDays).toContain("3 days per week");
  });
});

describe("time-zone windows", () => {
  const PROXIFY = "Proficiency with Git.\nLocated in CET timezone (+/- 3 hours), we are unable to consider applications from candidates in other time zones.";

  it("reads the zone, the width and whether it is enforced (Proxify)", () => {
    expect(extractTimezone(PROXIFY)).toMatchObject({ zone: "CET", baseOffset: 1, plusMinus: 3, hard: true });
    expect(extractTimezone("Nice-to-have: Located in CET timezone (+/- 3 hours).")?.hard).toBe(false);
  });

  it("rejects a Chihuahua candidate from an enforced CET +/-3 window, and only risks it when it is a preference", () => {
    expect(utcOffsetHours("America/Chihuahua")).toBe(-6);
    const { db } = testDb();
    const profile = sampleProfile({ location: { country: "Mexico", city: "Chihuahua", timezone: "America/Chihuahua" } });
    const hard = scoreJob(profile, analyzeJobRules(db, job(PROXIFY)), OPTIONS);
    expect(hard.hardConstraintFailures.some((f) => f.includes("CET"))).toBe(true);
    const soft = scoreJob(profile, analyzeJobRules(db, job("Nice-to-have: Located in CET timezone (+/- 3 hours).")), OPTIONS);
    expect(soft.hardConstraintFailures.some((f) => f.includes("CET"))).toBe(false);
    expect(soft.risks.some((r) => r.includes("CET"))).toBe(true);
  });
});

describe("salary printed in prose", () => {
  it.each([
    ["The US base salary range for this full-time position is $248,000 to $341,000 + equity + benefits.", 248000, 341000, "USD", "year"],
    ["Canada Base Pay Range $156,000 — $196,000 CAD We will ensure", 156000, 196000, "CAD", "year"],
    ["B2B contract-based monthly remuneration is 38.000 - 45.000 PLN + VAT or its equivalent.", 38000, 45000, "PLN", "month"],
    ["Quill | Fullstack SWE | Full-time | Remote | $150 - 210K USD + equity", 150000, 210000, "USD", "year"],
    ["Search Atlas | Full-time contractor | $23-$34 USD/hour | https://careers", 23, 34, "USD", "hour"],
    ["Compensation Range: €115,200 to €133,000 base plus bonus and equity", 115200, 133000, "EUR", "year"],
    ["$180,000 - $250,000 a year. Plus stock options.", 180000, 250000, "USD", "year"],
  ])("%s", (text, min, max, currency, period) => {
    expect(extractSalary(text)).toMatchObject({ min, max, currency, period, explicit: true });
  });

  it("does not mistake years, dates or percentages for pay", () => {
    expect(extractSalary("7-10 years of experience, 2007–2012, a 5-10% adjustment outside SF.")).toBeNull();
  });

  it("fills the analysis only when no explicit observation exists", () => {
    const { db } = testDb();
    const read = analyzeJobRules(db, job("Pay: $180,000 - $250,000 a year."));
    expect(read.compensation).toMatchObject({ min: 180000, max: 250000, currency: "USD" });
    expect(read.missingInformation).not.toContain("compensation");
    const given = analyzeJobRules(db, job("Pay: $180,000 - $250,000 a year."), { min: 1, max: 2, currency: "USD", period: "year", explicit: true });
    expect(given.compensation?.min).toBe(1);
  });
});

describe("language requirements", () => {
  // VAC-1.72, Tiugo Technologies. Polish is required; the benefits line mentions three languages
  // that are not requirements at all.
  const TIUGO = [
    "Job requirements",
    "8+ years of experience in software engineering.",
    "Fluency in Polish and English (minimum C1 level).",
    "Nice to have:",
    "Experience with rich text editors.",
    "Why join CKSource:",
    "English lessons with a native speaker and an online language platform where you can learn English, Spanish, and German.",
  ].join("\n");

  it("finds Polish as required and leaves the benefits line alone", () => {
    const langs = extractLanguages(segment(TIUGO));
    expect(langs.find((l) => l.code === "pl")).toMatchObject({ minLevel: "c1", required: true });
    expect(langs.find((l) => l.code === "en")?.required).toBe(true);
    expect(langs.find((l) => l.code === "de")).toBeUndefined();
  });

  it("rejects a candidate who does not speak a required language", () => {
    const { db } = testDb();
    const profile = sampleProfile({ languages: [{ code: "es", level: "native" }, { code: "en", level: "c2" }] });
    const result = scoreJob(profile, analyzeJobRules(db, job(TIUGO)), OPTIONS);
    expect(result.hardConstraintFailures.some((f) => f.includes("PL"))).toBe(true);
  });

  it("treats a language under nice-to-have as preferred, never as a rejection", () => {
    const { db } = testDb();
    const profile = sampleProfile({ languages: [{ code: "en", level: "c2" }] });
    const analysis = analyzeJobRules(db, job("Requirements\nStrong TypeScript.\nNice to have\nGerman."));
    expect(analysis.languages.find((l) => l.code === "de")?.required).toBe(false);
    expect(scoreJob(profile, analysis, OPTIONS).hardConstraintFailures).toEqual([]);
  });

  it("reads a fluency requirement phrased at length (Canonical)", () => {
    // 44 characters sit between "Excellent" and "English"; a 40-character window missed it.
    const langs = extractLanguages(segment("What we are looking for in you\nExcellent verbal and written communication skills in English"));
    expect(langs.find((l) => l.code === "en")).toMatchObject({ minLevel: "c1", required: true });
  });

  it("reads Japanese requirements written in Japanese", () => {
    expect(extractLanguages(segment("応募資格\nビジネスレベルの日本語")).find((l) => l.code === "ja")?.minLevel).toBe("c1");
  });
});
