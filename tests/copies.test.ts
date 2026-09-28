import { describe, expect, it } from "vitest";
import { runRuleAnalysis } from "../src/core/analyze-runner.js";
import { ingestRawJob } from "../src/core/ingest.js";
import { upsertProfile } from "../src/db/repositories/profile.js";
import type { JobAnalysis } from "../src/core/scoring.js";
import { rawJob, testDb } from "./helpers.js";

// Cognition's "Deployed Engineer - LATAM": one copy per city on the same Ashby board, identical but
// for the language the requirements name.
const posting = (language: string) =>
  `<p>Deployed Engineers work with customer engineering teams to deploy our agent into production.</p>
   <p>Requirements</p>
   <ul><li>MUST have Fluency / Native proficiency in ${language}</li>
   <li>Strong engineering foundation in TypeScript and Node.js</li>
   <li>Willingness to travel</li></ul>`;

function setup() {
  const { db, config } = testDb();
  upsertProfile(db, {
    full_name: "Test Candidate",
    seniority: "lead",
    years_experience: 15,
    languages: [
      { code: "es", level: "native" },
      { code: "en", level: "c2" },
    ],
    work_authorization: ["Mexico"],
    interview_completed: true,
  });
  const cfg = { ...config, matching: { ...config.matching, minimum_score: 0 } };
  return { db, cfg };
}

const copy = (location: string, language: string, id: string) =>
  rawJob({
    sourceKey: "ashby",
    externalId: `cognition:${id}`,
    url: `https://jobs.ashbyhq.com/cognition/${id}`,
    title: "Deployed Engineer - LATAM",
    companyName: "Cognition",
    location,
    country: null,
    description: posting(language),
    salary: null,
  });

function latestAnalysis(db: ReturnType<typeof testDb>["db"], jobId: number): { eligible: number; analysis: JobAnalysis } {
  const m = db.prepare("SELECT eligible, analysis_json FROM job_matches WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as {
    eligible: number;
    analysis_json: string;
  };
  return { eligible: m.eligible, analysis: JSON.parse(m.analysis_json) as JobAnalysis };
}

describe("same-source copies that differ in more than the place", () => {
  it("scores the group by the copy the candidate can take, and points the hand-off at it", () => {
    const { db, cfg } = setup();
    const saoPaulo = ingestRawJob(db, copy("Sao Paulo, Remote", "Portuguese", "sp")).job;
    const mexico = ingestRawJob(db, copy("Mexico City, Remote", "Spanish", "mx")).job;
    expect(mexico.duplicate_of_job_id).toBe(saoPaulo.id);

    runRuleAnalysis(db, cfg);
    const { eligible, analysis } = latestAnalysis(db, saoPaulo.id);

    expect(eligible).toBe(1);
    expect(analysis.scoredCopy?.jobId).toBe(mexico.id);
    expect(analysis.scoredCopy?.url).toContain("/mx");
    expect(analysis.scoredCopy?.canonicalFailures.join(" ")).toMatch(/pt|Portuguese/i);
  });

  it("leaves a rejection alone when no copy passes either", () => {
    const { db, cfg } = setup();
    const saoPaulo = ingestRawJob(db, copy("Sao Paulo, Remote", "Portuguese", "sp")).job;
    ingestRawJob(db, copy("Tokyo, Remote", "Japanese", "jp"));

    runRuleAnalysis(db, cfg);
    const { eligible, analysis } = latestAnalysis(db, saoPaulo.id);

    expect(eligible).toBe(0);
    expect(analysis.scoredCopy).toBeUndefined();
  });
});
