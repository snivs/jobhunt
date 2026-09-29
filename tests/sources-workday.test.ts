import { describe, expect, it } from "vitest";
import type { SourceContext } from "../src/sources/types.js";
import { countryFacets, workday } from "../src/sources/workday.js";

// Facet shapes trimmed from live boards on 2026-09-29 (hp.wd5, salesforce.wd12, jci.wd5).
const MX = "e2adff9272454660ac4fdb56fc70bb51";

describe("Workday country facets", () => {
  it("finds the country facet whatever the tenant calls it", () => {
    expect(countryFacets([{ facetParameter: "Location_Country", values: [{ id: "x", descriptor: "Canada" }, { id: MX, descriptor: "Mexico", count: 84 }] }], "Mexico")).toEqual({ Location_Country: [MX] });
    // Salesforce nests its facets under a group and names the country facet after a custom field.
    const nested = [
      {
        facetParameter: "locationMainGroup",
        values: [
          { facetParameter: "CF_-_REC_-_Country", values: [{ id: MX, descriptor: "Mexico", count: 77 }] },
          { facetParameter: "locations", values: [{ id: "a", descriptor: "Mexico - Mexico City" }] },
        ],
      },
    ];
    expect(countryFacets(nested, "Mexico")).toEqual({ "CF_-_REC_-_Country": [MX] });
  });

  it("falls back to every location naming the country, never New Mexico", () => {
    const jci = [
      {
        facetParameter: "locations",
        values: [
          { id: "abq", descriptor: "Albuquerque-New Mexico-United States of America" },
          { id: "apo", descriptor: "Apodaca-Nuevo Leon-Mexico" },
          { id: "dgo", descriptor: "Durango-Durango-Mexico" },
        ],
      },
    ];
    expect(countryFacets(jci, "Mexico")).toEqual({ locations: ["apo", "dgo"] });
    expect(countryFacets([{ facetParameter: "locations", values: [{ id: "abq", descriptor: "Santa Fe, New Mexico" }] }], "Mexico")).toBeNull();
  });

  it("reads only the country's postings, filtered by title, and refuses a board without the facet", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const http = {
      async getJson<T>(url: string, init?: { body?: string }): Promise<T> {
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url, body });
        if (url.includes("/nofacet/")) return { total: 1, jobPostings: [], facets: [] } as T;
        if (url.endsWith("/jobs")) {
          if (!body.appliedFacets.Location_Country) return { total: 900, facets: [{ facetParameter: "Location_Country", values: [{ id: MX, descriptor: "Mexico" }] }], jobPostings: [] } as T;
          return { total: 2, jobPostings: [{ title: "AI Engineer", externalPath: "/job/Mexico/AI-Engineer_1" }, { title: "Payroll Analyst", externalPath: "/job/Mexico/Payroll_2" }] } as T;
        }
        return { jobPostingInfo: { jobReqId: "R1", title: "AI Engineer", location: "Guadalajara, Mexico", jobDescription: "<p>LLMs</p>" } } as T;
      },
    };
    const ctx = {
      config: { key: "workday", boards: ["hp.wd5/Site", "hp.wd5/nofacet"], options: { country: "Mexico" } } as unknown as SourceContext["config"],
      terms: ["engineer"],
      limit: 50,
      http: http as unknown as SourceContext["http"],
      logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as SourceContext["logger"],
      env: {},
    } satisfies SourceContext;
    const jobs = await workday.fetch(ctx);
    expect(jobs.map((j) => j.title)).toEqual(["AI Engineer"]);
    expect(jobs[0]).toMatchObject({ externalId: "hp.wd5/Site:R1", location: "Guadalajara, Mexico" });
    expect(jobs[0]!.rawMetadata).toMatchObject({ path: "/job/Mexico/AI-Engineer_1" });
    expect(calls.filter((c) => c.url.endsWith("/Site/jobs")).map((c) => (c.body as { appliedFacets: unknown }).appliedFacets)).toEqual([{}, { Location_Country: [MX] }]);
    // The board without a country facet is skipped, not searched worldwide.
    expect(calls.filter((c) => c.url.includes("/nofacet/"))).toHaveLength(1);
  });
});
