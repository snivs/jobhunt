import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../src/config/index.js";
import { Logger } from "../src/logging/index.js";
import { HttpClient, SourceHttpError } from "../src/sources/http.js";
import { parseHiringComment } from "../src/sources/hn-hiring.js";
import { parseSalaryText, remotive } from "../src/sources/remotive.js";
import { runDiscovery, resolveSearchTerms } from "../src/sources/runner.js";
import { createRun, getRun } from "../src/db/repositories/runs.js";
import { countJobs } from "../src/db/repositories/jobs.js";
import { ROOT, testDb } from "./helpers.js";
import path from "node:path";

const logger = new Logger({ dir: path.join(ROOT, "logs"), level: "error", component: "test" });

function sourceConfig(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    key: "remotive",
    name: "Remotive",
    kind: "api",
    enabled: true,
    automation_policy: "discover_only",
    base_url: "https://remotive.example/api",
    boards: [],
    rate_limits: { requests_per_second: 100, requests_per_minute: 1000, requests_per_hour: 10000, concurrency: 2 },
    retry: { max_retries: 2, initial_backoff_ms: 1, backoff_multiplier: 2, max_backoff_ms: 5 },
    options: {},
    ...overrides,
  };
}

function fakeFetch(handler: (url: string) => { status: number; body: unknown; headers?: Record<string, string> }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const r = handler(url);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
}

describe("source adapters and discovery runner", () => {
  it("parses salary text and HN hiring lines", () => {
    expect(parseSalaryText("$90,000 - $120,000")).toMatchObject({ min: 90000, max: 120000, currency: "USD", period: "year" });
    expect(parseSalaryText("USD 8k-10k / month")).toMatchObject({ min: 8000, max: 10000, period: "month" });
    expect(parseSalaryText("competitive")).toEqual({ text: "competitive" });
    const p = parseHiringComment("Acme | Senior Backend Engineer | Remote (US) | Full-time | $150k-$190k\nWe build things.");
    expect(p).toMatchObject({ company: "Acme", title: "Senior Backend Engineer", remote: true, salaryText: "$150k-$190k" });
  });

  it("retries retryable errors and surfaces definitive ones", async () => {
    let calls = 0;
    const http = new HttpClient({
      config: sourceConfig(),
      logger,
      fetchImpl: fakeFetch(() => {
        calls++;
        return calls < 3 ? { status: 503, body: "down" } : { status: 200, body: { ok: true } };
      }),
    });
    expect(await http.getJson("https://remotive.example/x")).toEqual({ ok: true });
    expect(calls).toBe(3);
    const bad = new HttpClient({ config: sourceConfig(), logger, fetchImpl: fakeFetch(() => ({ status: 404, body: "nope" })) });
    await expect(bad.getJson("https://remotive.example/y")).rejects.toBeInstanceOf(SourceHttpError);
  });

  it("maps remotive postings to RawJob and filters by terms", async () => {
    const http = new HttpClient({
      config: sourceConfig(),
      logger,
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: {
          jobs: [
            { id: 1, url: "https://remotive.com/j/1", title: "Senior TypeScript Engineer", company_name: "Acme", category: "Software Development", job_type: "full_time", publication_date: "2026-09-01T00:00:00", candidate_required_location: "LATAM", salary: "$100k - $130k", description: "<p>TS</p>", tags: ["typescript"] },
            { id: 2, url: "https://remotive.com/j/2", title: "Sales Manager", company_name: "Acme", category: "Sales", job_type: "full_time", publication_date: "2026-09-01T00:00:00", candidate_required_location: "Worldwide", salary: "", description: "<p>Sell</p>", tags: [] },
          ],
        },
      })),
    });
    const jobs = await remotive.fetch({ config: sourceConfig(), terms: ["typescript"], limit: 10, http, logger, env: {} });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ sourceKey: "remotive", externalId: "1", workMode: "remote", remoteScope: "LATAM", employmentType: "full_time" });
    expect(jobs[0]!.salary).toMatchObject({ min: 100000, max: 130000, currency: "USD" });
  });

  it("runs discovery per source, isolates failures and records results", async () => {
    const { db, config: baseConfig } = testDb();
    const config = { ...baseConfig, sources: baseConfig.sources.map((s) => ({ ...s, retry: { ...s.retry, initial_backoff_ms: 1, max_backoff_ms: 5 } })) };
    const run = createRun(db, { runKey: "disc-1", trigger: "manual" }).run;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch((url) => {
      if (url.startsWith("https://remotive.com")) {
        return { status: 200, body: { jobs: [{ id: 7, url: "https://remotive.com/j/7", title: "Senior TypeScript Engineer", company_name: "Acme", category: "Dev", job_type: "full_time", publication_date: "2026-09-01T00:00:00", candidate_required_location: "Worldwide", salary: "$100k-$120k", description: "TS" }] } };
      }
      return { status: 500, body: "boom" };
    });
    try {
      const summaries = await runDiscovery(db, config, { runId: run.id, sourceKeys: ["remotive", "arbeitnow", "lever", "linkedin"], terms: ["typescript"], logger, expireDays: 0 });
      const byKey = Object.fromEntries(summaries.map((s) => [s.source, s]));
      expect(byKey.remotive).toMatchObject({ status: "success", jobs_found: 1, jobs_new: 1, compensation_recorded: 1 });
      expect(byKey.arbeitnow?.status).toBe("failed");
      expect(byKey.arbeitnow?.retry_count).toBeGreaterThan(0);
      expect(byKey.lever).toMatchObject({ status: "skipped", error: "no boards configured" });
      expect(byKey.linkedin?.status).toBe("blocked");
      expect(countJobs(db).canonical).toBe(1);
      const view = getRun(db, run.id)!;
      expect(view.stats.jobs_new).toBe(1);
      expect(view.errors.some((e) => e.source === "arbeitnow" && e.operation === "fetch")).toBe(true);
      // second discovery: unchanged, still one job
      const again = await runDiscovery(db, config, { runId: run.id, sourceKeys: ["remotive"], terms: ["typescript"], logger, expireDays: 0 });
      expect(again[0]).toMatchObject({ status: "success", jobs_new: 0, unchanged: 1 });
      expect(countJobs(db).canonical).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves search terms from preferences or profile", () => {
    const { db } = testDb();
    expect(resolveSearchTerms(db, ["Staff Engineer"])).toEqual(["staff engineer"]);
    expect(resolveSearchTerms(db)).toEqual([]);
  });
});
