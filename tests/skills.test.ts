import { describe, expect, it } from "vitest";
import { ingestRawJob } from "../src/core/ingest.js";
import { ensureSkill, getCandidateSkillGaps, getJobSkills, getSkillCooccurrence, getSkillMarketDemand, recordJobSkill, searchSkills, slugify } from "../src/db/repositories/skills.js";
import { setCandidateSkill, upsertProfile } from "../src/db/repositories/profile.js";
import { rawJob, testDb } from "./helpers.js";

describe("skills: normalization, explicit vs expected, demand statistics", () => {
  it("resolves aliases to canonical skills", () => {
    const { db } = testDb();
    expect(ensureSkill(db, "k8s").name).toBe("Kubernetes");
    expect(ensureSkill(db, "NodeJS").name).toBe("Node.js");
    expect(ensureSkill(db, "node").slug).toBe("nodejs");
    expect(ensureSkill(db, "Golang").name).toBe("Go");
    expect(ensureSkill(db, "Postgres").name).toBe("PostgreSQL");
    expect(slugify("C++")).toBe("c++");
    expect(slugify("React.js")).toBe("reactjs");
    const created = ensureSkill(db, "Temporal.io", "infrastructure");
    expect(created.category).toBe("infrastructure");
    expect(ensureSkill(db, "temporal.io").id).toBe(created.id);
  });

  it("keeps explicit and expected mentions distinct and preserves the raw form", () => {
    const { db } = testDb();
    const job = ingestRawJob(db, rawJob()).job;
    recordJobSkill(db, { jobId: job.id, skillName: "TypeScript", mentionType: "explicit_required", confidence: 0.95, evidence: "We need TypeScript", rawForm: "TypeScript" });
    recordJobSkill(db, { jobId: job.id, skillName: "ts", mentionType: "explicit_required", confidence: 0.7, evidence: "dup" });
    recordJobSkill(db, { jobId: job.id, skillName: "Docker", mentionType: "expected", confidence: 0.5, evidence: "inferred from AWS + microservices" });
    const skills = getJobSkills(db, job.id);
    expect(skills).toHaveLength(2);
    const ts = skills.find((s) => s.skill_slug === "typescript")!;
    expect(ts.mention_type).toBe("explicit_required");
    expect(ts.confidence).toBe(0.95); // max wins on upsert
    expect(ts.raw_form).toBe("TypeScript");
    const docker = skills.find((s) => s.skill_slug === "docker")!;
    expect(docker.mention_type).toBe("expected");
    expect(() => recordJobSkill(db, { jobId: job.id, skillName: "x", mentionType: "mentioned", confidence: 2 })).toThrow();
  });

  it("counts distinct jobs separately from mentions", () => {
    const { db } = testDb();
    const j1 = ingestRawJob(db, rawJob()).job;
    const j2 = ingestRawJob(db, rawJob({ externalId: "e2", url: "https://remotive.com/2", title: "Backend Engineer", companyName: "Beta" })).job;
    recordJobSkill(db, { jobId: j1.id, skillName: "TypeScript", mentionType: "explicit_required", confidence: 0.9 });
    recordJobSkill(db, { jobId: j1.id, skillName: "TypeScript", mentionType: "mentioned", confidence: 0.9 });
    recordJobSkill(db, { jobId: j2.id, skillName: "TypeScript", mentionType: "explicit_preferred", confidence: 0.9 });
    recordJobSkill(db, { jobId: j2.id, skillName: "AWS", mentionType: "expected", confidence: 0.5 });
    const demand = getSkillMarketDemand(db, {});
    expect(demand.total_jobs).toBe(2);
    const ts = demand.skills.find((s) => s.slug === "typescript")!;
    expect(ts.job_count).toBe(2);
    expect(ts.mention_count).toBe(3);
    expect(ts.explicit_required).toBe(1);
    expect(ts.explicit_preferred).toBe(1);
    expect(ts.share_of_jobs).toBe(100);
    const explicitOnly = getSkillMarketDemand(db, { mentionTypes: ["explicit_required", "explicit_preferred"] });
    expect(explicitOnly.skills.find((s) => s.slug === "aws")).toBeUndefined();
    expect(getSkillCooccurrence(db, "typescript")[0]?.slug).toBe("aws");
    expect(searchSkills(db, "type")[0]?.slug).toBe("typescript");
  });

  it("reports skill gaps for the candidate", () => {
    const { db } = testDb();
    upsertProfile(db, { full_name: "Test" });
    setCandidateSkill(db, { skillName: "TypeScript", level: "expert" });
    const job = ingestRawJob(db, rawJob()).job;
    recordJobSkill(db, { jobId: job.id, skillName: "TypeScript", mentionType: "explicit_required", confidence: 0.9 });
    recordJobSkill(db, { jobId: job.id, skillName: "Kubernetes", mentionType: "explicit_required", confidence: 0.9 });
    const gaps = getCandidateSkillGaps(db);
    expect(gaps.map((g) => g.slug)).toEqual(["kubernetes"]);
  });
});
