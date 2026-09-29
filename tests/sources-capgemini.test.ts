import { describe, expect, it } from "vitest";
import { capgemini, capgeminiWorkMode } from "../src/sources/capgemini.js";
import type { SourceContext } from "../src/sources/types.js";

// Shapes trimmed from cg-jobstream-api.azurewebsites.net/api/job-search?country_code=es-mx on 2026-09-29.

const API = "https://cg-jobstream-api.azurewebsites.net/api/job-search";

function ctx(responses: Record<string, unknown>, terms: string[] = []): { ctx: SourceContext; calls: string[] } {
  const calls: string[] = [];
  const http = {
    async getJson<T>(url: string): Promise<T> {
      calls.push(url);
      if (!(url in responses)) throw new Error(`HTTP 404 ${url}`);
      return responses[url] as T;
    },
  };
  const c = {
    config: { key: "capgemini", boards: ["es-mx"], options: {} } as unknown as SourceContext["config"],
    terms,
    limit: 50,
    http: http as unknown as SourceContext["http"],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as SourceContext["logger"],
    env: {},
  } satisfies SourceContext;
  return { ctx: c, calls };
}

const job = (ref: string, title: string, body: string, extra: Record<string, unknown> = {}) => ({
  id: `${ref}_SAPBTP`,
  ref,
  title,
  brand: "Capgemini",
  location: "Aguascalientes",
  country_code: "es-mx",
  contract_type: "Permanent",
  professional_communities: "Data & AI",
  description: body,
  apply_job_url: `https://careers.capgemini.com/job/Aguascalientes-X/${ref.split("-")[0]}/?feedId=388633&utm_source=CareerSite&tcsource=apply`,
  indexed_at: "2026-09-28T18:00:00.000Z",
  deleted_at: "",
  status: "1",
  ...extra,
});

describe("Capgemini careers", () => {
  it("reads the Mexico site, drops per-language copies and tracking parameters, and reads the work mode", async () => {
    const page = {
      total: 3,
      data: [
        job("563609-en_US", "Jr Gen AI Engineer", "<p>Posici&oacute;n: Gen AI Engineer</p><p>Modalidad de trabajo:&nbsp;Hibrido</p><p>Python, LLMs</p>"),
        job("563609-en_GB", "Jr Gen AI Engineer", "<p>Same requisition, other language index</p>"),
        job("559269-en_GB", "ABL - Tester Funcional", "<p>Modalidad de trabajo: Presencial</p>", { professional_communities: "Quality Engineering & Testing" }),
      ],
    };
    const { ctx: c, calls } = ctx({ [`${API}?country_code=es-mx&page=1&size=100`]: page });
    const jobs = await capgemini.fetch(c);
    expect(calls).toHaveLength(1);
    expect(jobs.map((j) => j.externalId)).toEqual(["es-mx:563609", "es-mx:559269"]);
    expect(jobs[0]).toMatchObject({
      url: "https://careers.capgemini.com/job/Aguascalientes-X/563609/",
      companyName: "Capgemini",
      location: "Aguascalientes, Mexico",
      country: "Mexico",
      workMode: "hybrid",
    });
    expect(jobs[0]!.description).toContain("Python, LLMs");
    expect(jobs[1]!.workMode).toBe("onsite");
  });

  it("filters by search terms on title and professional community", async () => {
    const page = { total: 2, data: [job("1-en_GB", "Gen AI Engineer", "x"), job("2-en_GB", "Tester Funcional", "x", { professional_communities: "Business Analysis" })] };
    const { ctx: c } = ctx({ [`${API}?country_code=es-mx&page=1&size=100`]: page }, ["engineer"]);
    expect((await capgemini.fetch(c)).map((j) => j.title)).toEqual(["Gen AI Engineer"]);
  });

  it("verifies a posting by searching its requisition number", async () => {
    const { ctx: c } = ctx({
      [`${API}?country_code=es-mx&page=1&size=10&search=563609`]: { total: 1, data: [job("563609-en_US", "Jr Gen AI Engineer", "x")] },
      [`${API}?country_code=es-mx&page=1&size=10&search=999`]: { total: 0, data: [] },
    });
    expect(await capgemini.verify!(c, { external_id: "es-mx:563609" } as never)).toBe("active");
    expect(await capgemini.verify!(c, { external_id: "es-mx:999" } as never)).toBe("expired");
  });

  it("reads Spanish work-mode phrasing", () => {
    expect(capgeminiWorkMode("Modalidad: Híbrida")).toBe("hybrid");
    expect(capgeminiWorkMode("Modalidad de trabajo: Remota")).toBe("remote");
    expect(capgeminiWorkMode("Ubicación: CDMX")).toBeNull();
  });
});
