import { describe, expect, it } from "vitest";
import { explainMatch, scoreJob, type ScoringOptions } from "../src/core/scoring.js";
import { sampleAnalysis, sampleProfile, testConfig } from "./helpers.js";

const cfg = testConfig();
const options: ScoringOptions = {
  weights: cfg.matching.weights,
  minimumScore: cfg.matching.minimum_score,
  undisclosedCompensationScore: cfg.matching.undisclosed_compensation_score,
  scoringVersion: cfg.matching.scoring_version,
};

describe("explainable scoring", () => {
  it("scores a strong match as eligible with per-factor explanations", () => {
    const r = scoreJob(sampleProfile(), sampleAnalysis(), options);
    expect(r.overallScore).toBeGreaterThanOrEqual(85);
    expect(r.eligible).toBe(true);
    expect(r.hardConstraintFailures).toEqual([]);
    expect(r.factors.find((f) => f.factor === "required_skill_match")?.score).toBe(100);
    expect(r.factors.find((f) => f.factor === "location_match")?.score).toBe(100);
    expect(r.factors.find((f) => f.factor === "compensation_match")?.score).toBe(90);
    expect(r.strengths.some((s) => s.includes("TypeScript"))).toBe(true);
    expect(explainMatch(r)).toContain("Overall:");
  });

  it("rejects a job below the salary hard constraint even with a high technical score", () => {
    const r = scoreJob(sampleProfile(), sampleAnalysis({ compensation: { min: 40000, max: 60000, currency: "USD", period: "year", explicit: true } }), options);
    expect(r.eligible).toBe(false);
    expect(r.hardConstraintFailures[0]).toMatch(/below minimum/);
    expect(r.factors.find((f) => f.factor === "compensation_match")?.score).toBe(0);
  });

  it("rejects on-site jobs when only remote is allowed", () => {
    const r = scoreJob(sampleProfile(), sampleAnalysis({ workMode: "onsite", country: "Germany" }), options);
    expect(r.eligible).toBe(false);
    expect(r.hardConstraintFailures.join(" ")).toMatch(/Work mode onsite/);
  });

  it("flags undisclosed salary as a risk and missing information, without rejecting", () => {
    const r = scoreJob(sampleProfile(), sampleAnalysis({ compensation: null }), options);
    expect(r.risks).toContain("Salary not disclosed");
    expect(r.missingInformation).toContain("compensation");
    expect(r.factors.find((f) => f.factor === "compensation_match")?.score).toBe(cfg.matching.undisclosed_compensation_score);
    expect(r.eligible).toBe(true);
  });

  it("applies the undisclosed-salary hard constraint only when configured", () => {
    const profile = sampleProfile({ hardConstraints: [{ type: "min_salary", amount: 80000, currency: "USD", period: "year", applyWhenUndisclosed: true }] });
    const r = scoreJob(profile, sampleAnalysis({ compensation: null }), options);
    expect(r.eligible).toBe(false);
  });

  it("penalizes missing required skills and lists them as risks", () => {
    const analysis = sampleAnalysis({ skills: [...sampleAnalysis().skills, { slug: "kubernetes", name: "Kubernetes", mentionType: "explicit_required" }, { slug: "rust", name: "Rust", mentionType: "explicit_required" }] });
    const r = scoreJob(sampleProfile(), analysis, options);
    expect(r.risks).toContain("Missing required skill: Kubernetes");
    expect(r.factors.find((f) => f.factor === "required_skill_match")?.score).toBe(50);
    expect(r.overallScore).toBeLessThan(scoreJob(sampleProfile(), sampleAnalysis(), options).overallScore);
  });

  it("renormalizes weights over applicable factors", () => {
    const minimal = sampleAnalysis({ skills: [], yearsExperienceRequired: null, leadershipRequired: false, languages: [], industry: null, responsibilities: [], compensation: null, seniority: "unknown", workMode: "remote", remoteScope: "Worldwide" });
    const r = scoreJob(sampleProfile(), minimal, options);
    const applicable = r.factors.filter((f) => f.applicable);
    expect(applicable.map((f) => f.factor).sort()).toEqual(["compensation_match", "location_match", "preference_match"]);
    const w = applicable.reduce((a, f) => a + f.weight, 0);
    const expected = Math.round((applicable.reduce((a, f) => a + f.score * f.weight, 0) / w) * 10) / 10;
    expect(r.overallScore).toBe(expected);
    expect(r.missingInformation).toContain("seniority");
  });

  it("scores remote-restricted-to-other-country low and worldwide remote high", () => {
    const restricted = scoreJob(sampleProfile(), sampleAnalysis({ country: "United States", remoteScope: "US only" }), options);
    expect(restricted.factors.find((f) => f.factor === "location_match")?.score).toBe(30);
    const worldwide = scoreJob(sampleProfile(), sampleAnalysis({ country: null, remoteScope: "Worldwide" }), options);
    expect(worldwide.factors.find((f) => f.factor === "location_match")?.score).toBe(100);
  });

  it("does not compare compensation across currencies automatically", () => {
    const r = scoreJob(sampleProfile(), sampleAnalysis({ compensation: { min: 60000, max: 80000, currency: "EUR", period: "year", explicit: true } }), options);
    const comp = r.factors.find((f) => f.factor === "compensation_match")!;
    expect(comp.score).toBe(65);
    expect(comp.explanation).toMatch(/not compared/);
    expect(r.hardConstraintFailures).toEqual([]);
  });
});
