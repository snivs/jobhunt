import { describe, expect, it } from "vitest";
import { ingestRawJob } from "../src/core/ingest.js";
import { getJobCompensation } from "../src/db/repositories/compensation.js";
import { countJobs, getJobVersions, searchJobs } from "../src/db/repositories/jobs.js";
import { rawJob, testDb } from "./helpers.js";

describe("deduplication and idempotent ingestion", () => {
  it("same job discovered twice -> one job record", () => {
    const { db } = testDb();
    const first = ingestRawJob(db, rawJob());
    const second = ingestRawJob(db, rawJob());
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("unchanged");
    expect(second.job.id).toBe(first.job.id);
    expect(countJobs(db)).toEqual({ total: 1, canonical: 1, duplicates: 0 });
    expect(first.compensation_recorded).toBe(true);
    expect(second.compensation_recorded).toBe(false);
    expect(getJobCompensation(db, first.job.id)).toHaveLength(1);
  });

  it("changed content -> updated record with version history", () => {
    const { db } = testDb();
    const first = ingestRawJob(db, rawJob());
    const second = ingestRawJob(db, rawJob({ description: "Now we also need Kubernetes." }));
    expect(second.outcome).toBe("updated");
    expect(second.job.id).toBe(first.job.id);
    expect(getJobVersions(db, first.job.id)).toHaveLength(2);
    expect(second.job.description).toContain("Kubernetes");
  });

  it("same posting from a second source is flagged as duplicate, not counted twice", () => {
    const { db } = testDb();
    const a = ingestRawJob(db, rawJob());
    const b = ingestRawJob(db, rawJob({ sourceKey: "remoteok", externalId: "rok-1", url: "https://remoteok.com/remote-jobs/1", companyName: "ACME Inc" }));
    expect(b.outcome).toBe("duplicate");
    expect(b.duplicateOfJobId).toBe(a.job.id);
    expect(countJobs(db)).toEqual({ total: 2, canonical: 1, duplicates: 1 });
    expect(searchJobs(db)).toHaveLength(1);
    expect(searchJobs(db, { includeDuplicates: true })).toHaveLength(2);
  });

  it("different jobs at the same company are separate records", () => {
    const { db } = testDb();
    ingestRawJob(db, rawJob());
    const other = ingestRawJob(db, rawJob({ externalId: "ext-2", url: "https://remotive.com/remote-jobs/2", title: "Engineering Manager" }));
    expect(other.outcome).toBe("created");
    expect(countJobs(db).canonical).toBe(2);
  });

  it("jobs without external id are identified by canonical url within a source", () => {
    const { db } = testDb();
    const a = ingestRawJob(db, rawJob({ externalId: null, url: "https://acme.com/careers/42?utm_campaign=a" }));
    const b = ingestRawJob(db, rawJob({ externalId: null, url: "https://acme.com/careers/42?utm_campaign=b" }));
    expect(b.job.id).toBe(a.job.id);
    expect(b.outcome).toBe("unchanged");
  });
});
