import { describe, expect, it } from "vitest";
import { ingestRawJob } from "../src/core/ingest.js";
import { getCompensationStatistics, recordCompensation } from "../src/db/repositories/compensation.js";
import { rawJob, testDb } from "./helpers.js";

describe("compensation: explicit vs expected", () => {
  it("never mixes explicit and expected observations and annualizes periods", () => {
    const { db } = testDb();
    const job = ingestRawJob(db, rawJob()).job; // explicit 90k-120k USD/year from posting
    recordCompensation(db, { jobId: job.id, observationType: "expected", minAmount: 9000, maxAmount: 11000, currency: "USD", period: "month", source: "agent_estimate", confidence: 0.6, methodology: "market comparables" });
    recordCompensation(db, { jobId: job.id, observationType: "explicit", minAmount: 100000, maxAmount: 130000, currency: "USD", period: "year", source: "job_posting" });
    recordCompensation(db, { jobId: null, observationType: "explicit", minAmount: 50, maxAmount: 70, currency: "USD", period: "hour", source: "job_posting" });
    const stats = getCompensationStatistics(db, { currency: "USD", minSampleSize: 1 });
    expect(stats.explicit.sample_size).toBe(3);
    expect(stats.expected.sample_size).toBe(1);
    expect(stats.expected.median_midpoint).toBe(120000); // 10k/month * 12
    expect(stats.explicit.max).toBe(70 * 2080);
    expect(stats.expected.mean_confidence).toBe(0.6);
  });

  it("requires methodology and confidence for estimates and is idempotent", () => {
    const { db } = testDb();
    expect(() => recordCompensation(db, { observationType: "expected", minAmount: 1, maxAmount: 2, currency: "USD", period: "year", source: "agent_estimate" })).toThrow(/methodology/);
    const a = recordCompensation(db, { observationType: "explicit", minAmount: 100, maxAmount: 200, currency: "eur", period: "day", source: "job_posting" });
    const b = recordCompensation(db, { observationType: "explicit", minAmount: 100, maxAmount: 200, currency: "EUR", period: "day", source: "job_posting" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.observation.id).toBe(a.observation.id);
  });

  it("hides statistics below the minimum sample size", () => {
    const { db } = testDb();
    recordCompensation(db, { observationType: "explicit", minAmount: 100000, maxAmount: 120000, currency: "USD", period: "year", source: "job_posting" });
    const stats = getCompensationStatistics(db, { currency: "USD", minSampleSize: 3 });
    expect(stats.explicit.sample_size).toBe(1);
    expect(stats.explicit.insufficient_sample).toBe(true);
    expect(stats.explicit.median_midpoint).toBeNull();
  });
});
