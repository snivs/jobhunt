import { describe, expect, it } from "vitest";
import { buildDedupKey, canonicalizeUrl, htmlToText, inferEmploymentType, inferSeniority, inferWorkMode, normalizeCompanyName, normalizeJob, normalizeTitle } from "../src/core/normalize.js";
import { rawJob } from "./helpers.js";

describe("job normalization", () => {
  it("strips tracking params and normalizes host", () => {
    expect(canonicalizeUrl("https://WWW.Example.com/jobs/1/?utm_source=li&gh_src=abc#apply")).toBe("https://example.com/jobs/1");
    expect(canonicalizeUrl("https://example.com/jobs/1?b=2&a=1")).toBe("https://example.com/jobs/1?a=1&b=2");
  });

  it("normalizes titles and company names", () => {
    expect(normalizeTitle("Senior TypeScript Engineer (Remote) - m/f/d")).toBe("senior typescript engineer");
    expect(normalizeCompanyName("Acme, Inc.")).toBe("acme");
    expect(normalizeCompanyName("ACME S.A. de C.V.")).toBe("acme");
    expect(normalizeCompanyName("Ünïcode GmbH")).toBe("unicode");
  });

  it("infers work mode, seniority and employment type", () => {
    expect(inferWorkMode("Fully remote team", null)).toBe("remote");
    expect(inferWorkMode("Hybrid, 2 days in office", "Berlin")).toBe("hybrid");
    expect(inferWorkMode("On-site in Austin", null)).toBe("onsite");
    expect(inferWorkMode("Nothing here", null)).toBe("unknown");
    expect(inferSeniority("Staff Engineer")).toBe("staff");
    expect(inferSeniority("Sr. Backend Developer")).toBe("senior");
    expect(inferSeniority("Engineering Manager")).toBe("manager");
    expect(inferSeniority("Backend Developer", "You have 5+ years of experience")).toBe("mid");
    expect(inferEmploymentType("Full-time position")).toBe("full_time");
    expect(inferEmploymentType("B2B contract")).toBe("contract");
  });

  it("converts html descriptions to text", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b></p><ul><li>a</li><li>b</li></ul>")).toBe("Hello world\na\nb");
  });

  it("produces a stable dedup key regardless of source noise", () => {
    const a = normalizeJob(rawJob());
    const b = normalizeJob(rawJob({ sourceKey: "remoteok", externalId: "other", url: "https://remoteok.com/remote-jobs/999", title: "Senior TypeScript Engineer (Remote)", companyName: "ACME, Inc", description: "Slightly different wording of the same posting." }));
    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(buildDedupKey(null, "x", "https://a")).not.toBe(buildDedupKey(null, "x", "https://b"));
  });

  it("normalizes the full job", () => {
    const n = normalizeJob(rawJob());
    expect(n.canonicalUrl).toBe("https://remotive.com/remote-jobs/software-dev/senior-typescript-engineer-123");
    expect(n.workMode).toBe("remote");
    expect(n.seniority).toBe("senior");
    expect(n.description).toContain("TypeScript");
    expect(n.description).not.toContain("<b>");
    expect(n.postedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(n.salary?.max).toBe(120000);
  });
});

describe("non-Latin company names", () => {
  it("keeps scripts that are not Latin instead of erasing them", () => {
    // These normalized to the empty string before 2026-09-27, so ingestion rejected the posting
    // with "Company name is required" and 21 Japanese jobs were silently dropped in one run.
    expect(normalizeCompanyName("グリッド")).toBe("グリッド");
    expect(normalizeCompanyName("Наука")).toBe("наука");
    expect(normalizeCompanyName("北京字节跳动")).toBe("北京字节跳动");
    expect(normalizeCompanyName("테크놀로지")).toBe("테크놀로지");
  });

  it("keeps Japanese voiced marks, which decompose into separate combining characters", () => {
    // Stripping every mark turned ジ into シ and ド into ト: a different company name.
    expect(normalizeCompanyName("テオリア・テクノロジーズ")).toBe("テオリア テクノロジーズ");
    expect(normalizeCompanyName("ジーニー")).toBe("ジーニー");
  });

  it("still folds Latin accents and strips punctuation exactly as before", () => {
    expect(normalizeTitle("Migración a la Nube")).toBe("migracion a la nube");
    expect(normalizeTitle("Ingeniería de Software")).toBe("ingenieria de software");
    expect(normalizeTitle("Tech Lead — Code Plane [IC5]")).toBe("tech lead code plane");
    expect(normalizeCompanyName("Grupo Cambher, S.A. de C.V.")).toBe("grupo cambher");
    expect(normalizeCompanyName("Acme Inc.")).toBe("acme");
  });

  it("does not let symbols or emoji through", () => {
    // Asserted on the company normalizer to isolate this from normalizeTitle, which separately
    // strips parentheticals like "(Remote)".
    expect(normalizeCompanyName("Acme 🚀 Labs")).toBe("acme labs");
    expect(normalizeCompanyName("★ Nova ★")).toBe("nova");
  });
});
