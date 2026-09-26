import { describe, expect, it } from "vitest";
import { explainMatch, scoreJob, type CandidateProfile, type ScoringOptions } from "../src/core/scoring.js";
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

  it("does not compare compensation across currencies without an fx rate", () => {
    const r = scoreJob(sampleProfile(), sampleAnalysis({ compensation: { min: 60000, max: 80000, currency: "EUR", period: "year", explicit: true } }), { ...options, fxRates: {} });
    const comp = r.factors.find((f) => f.factor === "compensation_match")!;
    expect(comp.score).toBe(65);
    expect(comp.explanation).toMatch(/not compared/);
    expect(r.hardConstraintFailures).toEqual([]);
  });

  it("converts compensation with configured fx rates (direct and inverse)", () => {
    const mxnProfile = sampleProfile({ compensation: { minimum: 70000, target: 90000, currency: "MXN", period: "month" }, hardConstraints: [{ type: "min_salary", amount: 70000, currency: "MXN", period: "month" }] });
    const usd = scoreJob(mxnProfile, sampleAnalysis({ compensation: { min: 150000, max: 200000, currency: "USD", period: "year", explicit: true } }), { ...options, fxRates: { USD_MXN: 18.5 } });
    const comp = usd.factors.find((f) => f.factor === "compensation_match")!;
    expect(comp.score).toBe(100); // 150k USD = 2.775M MXN/yr > 1.08M target
    expect(comp.explanation).toMatch(/converted from/);
    const low = scoreJob(mxnProfile, sampleAnalysis({ compensation: { min: 20000, max: 30000, currency: "USD", period: "year", explicit: true } }), { ...options, fxRates: { USD_MXN: 18.5 } });
    expect(low.eligible).toBe(false);
    expect(low.hardConstraintFailures[0]).toMatch(/below minimum/);
    const inverse = scoreJob(mxnProfile, sampleAnalysis({ compensation: { min: 150000, max: 200000, currency: "USD", period: "year", explicit: true } }), { ...options, fxRates: { MXN_USD: 0.054 } });
    expect(inverse.factors.find((f) => f.factor === "compensation_match")!.score).toBe(100);
  });
});

describe("workable_from hard constraint", () => {
  /** Candidate based in Mexico who will not relocate; every work mode is otherwise acceptable. */
  const stayer = (extra: Partial<CandidateProfile> = {}) =>
    sampleProfile({
      workModes: ["remote", "hybrid", "onsite"],
      relocation: false,
      hardConstraints: [
        { type: "workable_from", country: "Mexico", acceptedScopes: ["latam", "latin america", "north america", "americas"] },
      ],
      ...extra,
    });

  it("rejects a hybrid job in another country as requiring relocation", () => {
    const r = scoreJob(stayer(), sampleAnalysis({ workMode: "hybrid", country: "Germany", remoteScope: null }), options);
    expect(r.eligible).toBe(false);
    expect(r.hardConstraintFailures.join(" ")).toMatch(/relocating outside Mexico/);
  });

  it("accepts an onsite job in the candidate's own country", () => {
    const r = scoreJob(stayer(), sampleAnalysis({ workMode: "onsite", country: "Mexico", remoteScope: null }), options);
    expect(r.hardConstraintFailures).toEqual([]);
  });

  it("rejects remote work scoped to a region that excludes the candidate", () => {
    const us = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: "United States", remoteScope: "Remote (United States)" }), options);
    expect(us.eligible).toBe(false);
    expect(us.hardConstraintFailures.join(" ")).toMatch(/does not reach Mexico/);

    const eu = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: null, remoteScope: "Remote - European Union" }), options);
    expect(eu.eligible).toBe(false);
  });

  it("accepts remote work whose scope names the Americas, LATAM or the world", () => {
    for (const scope of ["Northern America, LATAM, Europe, APAC", "Europe and the Americas", "Anywhere in the World", "Mexico and Colombia"]) {
      const r = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: null, remoteScope: scope }), options);
      expect(r.hardConstraintFailures, scope).toEqual([]);
    }
  });

  it("does not mistake 'United States of America' for the Americas", () => {
    const r = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: null, remoteScope: "Remote within the United States of America" }), options);
    expect(r.hardConstraintFailures.join(" ")).toMatch(/does not reach Mexico/);
  });

  it("does not reject a remote job with no stated scope, but asks for a manual check", () => {
    const r = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: null, remoteScope: null }), options);
    expect(r.hardConstraintFailures).toEqual([]);
    expect(r.manualChecks.join(" ")).toMatch(/no stated scope/);
    expect(r.missingInformation.join(" ")).toMatch(/no stated scope/);
  });

  it("treats scopes made only of remote-work jargon as unstated, not as an excluding place", () => {
    for (const scope of ["Remote", "Remote and async", "Remote (scope not stated)", "Fully remote, distributed team"]) {
      const r = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: null, remoteScope: scope }), options);
      expect(r.hardConstraintFailures, scope).toEqual([]);
      expect(r.manualChecks.join(" "), scope).toMatch(/no stated scope/);
    }
  });

  it("still rejects a scope that names a real place, however it is worded", () => {
    for (const scope of ["Remote within Germany", "Fully remote, European Union only", "Remote - Stuttgart"]) {
      const r = scoreJob(stayer(), sampleAnalysis({ workMode: "remote", country: null, remoteScope: scope }), options);
      expect(r.hardConstraintFailures.join(" "), scope).toMatch(/does not reach Mexico/);
    }
  });
});

describe("excluded_responsibility and unevaluable custom constraints", () => {
  it("rejects a job whose responsibilities match an excluded tag", () => {
    const profile = sampleProfile({ hardConstraints: [{ type: "excluded_responsibility", tags: ["helpdesk", "100% support"] }] });
    const r = scoreJob(profile, sampleAnalysis({ responsibilities: ["run the helpdesk queue"] }), options);
    expect(r.eligible).toBe(false);
    expect(r.hardConstraintFailures.join(" ")).toMatch(/excludes/);
  });

  it("surfaces a custom constraint as a manual check instead of ignoring it", () => {
    const profile = sampleProfile({ hardConstraints: [{ type: "custom", key: "no_six_day_week", description: "Reject mandatory six-day weeks." }] });
    const r = scoreJob(profile, sampleAnalysis(), options);
    expect(r.eligible).toBe(true); // a rule the engine cannot evaluate must never reject silently
    expect(r.manualChecks.join(" ")).toMatch(/no_six_day_week/);
    expect(explainMatch(r)).toContain("Manual checks:");
  });
});
