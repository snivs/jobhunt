import { describe, expect, it } from "vitest";
import { ingestRawJob } from "../src/core/ingest.js";
import { getApplicationByJob, getOrCreateApplication } from "../src/db/repositories/applications.js";
import { buildJobCode, getJobByCode, parseJobCode, resolveJob, upsertJob } from "../src/db/repositories/jobs.js";
import { createRun } from "../src/db/repositories/runs.js";
import { normalizeJob } from "../src/core/normalize.js";
import { rawJob, testDb } from "./helpers.js";

describe("job short codes (VAC-<run>.<job>)", () => {
  it("builds and parses codes", () => {
    expect(buildJobCode(2, 119)).toBe("VAC-2.119");
    expect(buildJobCode(null, 7)).toBe("VAC-0.7");
    expect(parseJobCode(" vac-2.119 ")).toEqual({ runId: 2, jobId: 119 });
    expect(parseJobCode("VAC-2")).toBeNull();
    expect(parseJobCode("119")).toBeNull();
  });

  it("assigns a code carrying the discovery run on insert and keeps it on update", () => {
    const { db } = testDb();
    const { run } = createRun(db, { runKey: "test:codes", trigger: "manual" });
    const created = ingestRawJob(db, rawJob(), { runId: run.id });
    expect(created.outcome).toBe("created");
    expect(created.job.discovered_run_id).toBe(run.id);
    expect(created.job.code).toBe(`VAC-${run.id}.${created.job.id}`);

    const updated = upsertJob(db, normalizeJob(rawJob({ description: "<p>Changed description, TypeScript and Node.js, 7+ years.</p>" })), { runId: run.id + 1 });
    expect(updated.outcome).toBe("updated");
    expect(updated.job.code).toBe(created.job.code);
    expect(updated.job.discovered_run_id).toBe(run.id);
  });

  it("uses run 0 when ingested outside a run and resolves by id, numeric string or code", () => {
    const { db } = testDb();
    const created = ingestRawJob(db, rawJob());
    expect(created.job.code).toBe(`VAC-0.${created.job.id}`);
    expect(resolveJob(db, created.job.id)?.id).toBe(created.job.id);
    expect(resolveJob(db, String(created.job.id))?.id).toBe(created.job.id);
    expect(resolveJob(db, created.job.code.toLowerCase())?.id).toBe(created.job.id);
    expect(getJobByCode(db, "VAC-9.999")).toBeNull();
    expect(resolveJob(db, "nonsense")).toBeNull();
  });

  it("exposes the code on the application view", () => {
    const { db } = testDb();
    const created = ingestRawJob(db, rawJob());
    getOrCreateApplication(db, { jobId: created.job.id, runId: null });
    expect(getApplicationByJob(db, created.job.id)?.job_code).toBe(created.job.code);
  });
});
