import { describe, expect, it } from "vitest";
import { bamboohr } from "../src/sources/bamboohr.js";
import type { SourceContext } from "../src/sources/types.js";
import { workable } from "../src/sources/workable.js";

// Response shapes below are trimmed from the live endpoints on 2026-09-27
// (bitso.bamboohr.com/careers/list and apply.workable.com/api/v1/widget/accounts/kobotoolbox).

function ctx(boards: string[], responses: Record<string, unknown>, options: Record<string, unknown> = {}): { ctx: SourceContext; calls: string[] } {
  const calls: string[] = [];
  const http = {
    async getJson<T>(url: string): Promise<T> {
      calls.push(url);
      if (!(url in responses)) throw new Error(`HTTP 404 ${url}`);
      return responses[url] as T;
    },
  };
  const c = {
    config: { key: "x", boards, options } as unknown as SourceContext["config"],
    terms: [],
    limit: 50,
    http: http as unknown as SourceContext["http"],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as SourceContext["logger"],
    env: {},
  } satisfies SourceContext;
  return { ctx: c, calls };
}

describe("BambooHR careers", () => {
  const list = {
    meta: { totalCount: 2 },
    result: [
      { id: "1004", jobOpeningName: "Senior React Native Engineer", departmentLabel: "Engineering", location: { city: null, state: null }, atsLocation: { country: null }, isRemote: null, locationType: "1" },
      { id: "1002", jobOpeningName: "Growth Marketing Specialist (B2B)", departmentLabel: "Bitso Business", location: { city: "Mexico City", state: "Cuauhtémoc" }, atsLocation: { country: null }, isRemote: null, locationType: "2" },
    ],
  };
  const detail = (name: string, type: string, city: string | null) => ({
    result: {
      jobOpening: {
        jobOpeningShareUrl: `https://bitso.bamboohr.com/careers/x`,
        jobOpeningName: name,
        jobOpeningStatus: "Open",
        description: "<p><strong>Your Purpose</strong></p><p>Build the app.</p>",
        datePosted: "2026-09-16",
        location: { city, state: null, addressCountry: null },
        atsLocation: { country: null, state: null, city: null },
        locationType: type,
      },
    },
  });

  it("maps remote and hybrid openings and fetches details only for what passes the terms", async () => {
    const { ctx: c, calls } = ctx(["bitso"], {
      "https://bitso.bamboohr.com/careers/list": list,
      "https://bitso.bamboohr.com/careers/1004/detail": detail("Senior React Native Engineer", "1", null),
      "https://bitso.bamboohr.com/careers/1002/detail": detail("Growth Marketing Specialist (B2B)", "2", "Mexico City"),
    }, { "company:bitso": "Bitso" });
    const jobs = await bamboohr.fetch({ ...c, terms: ["engineer"] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ companyName: "Bitso", workMode: "remote", location: "Remote", country: null, externalId: "bitso:1004", postedAt: "2026-09-16" });
    expect(jobs[0]!.description).toContain("Build the app.");
    expect(calls.some((u) => u.endsWith("/1002/detail"))).toBe(false);
  });

  it("keeps the city on a hybrid opening", async () => {
    const { ctx: c } = ctx(["bitso"], {
      "https://bitso.bamboohr.com/careers/list": list,
      "https://bitso.bamboohr.com/careers/1004/detail": detail("Senior React Native Engineer", "1", null),
      "https://bitso.bamboohr.com/careers/1002/detail": detail("Growth Marketing Specialist (B2B)", "2", "Mexico City"),
    });
    const hybrid = (await bamboohr.fetch(c)).find((j) => j.externalId === "bitso:1002");
    expect(hybrid).toMatchObject({ workMode: "hybrid", location: "Mexico City" });
  });

  it("reports a posting gone when its detail disappears", async () => {
    const { ctx: c } = ctx(["bitso"], {});
    expect(await bamboohr.verify!(c, { external_id: "bitso:1004" } as never)).toBe("expired");
  });
});

describe("Lever description", () => {
  it("includes the requirement lists, not only the opening", async () => {
    const { leverDescription } = await import("../src/sources/ats.js");
    const d = leverDescription({
      descriptionPlain: "Sobre Kavak. Buscamos Staff Engineers.",
      lists: [
        { text: "Requisitos", content: "<li>Dominio de Java o Go (indispensable).</li>" },
        { text: "Beneficios en México", content: "<li>Aguinaldo</li>" },
      ],
      additionalPlain: "Kavak es un empleador con igualdad de oportunidades.",
    });
    expect(d).toContain("Requisitos\nDominio de Java o Go (indispensable).");
    expect(d).toContain("Beneficios en México");
    expect(d!.startsWith("Sobre Kavak")).toBe(true);
  });
});

describe("Workable careers widget", () => {
  const account = {
    name: "KoboToolbox",
    jobs: [
      {
        title: "Frontend Web Application Developer - Remote",
        shortcode: "D7EB6C2D99",
        url: "https://apply.workable.com/j/D7EB6C2D99",
        employment_type: "Full-time",
        telecommuting: true,
        published_on: "2026-09-13",
        country: "United States",
        city: "Cambridge",
        locations: [{ country: "United States", countryCode: "US", city: "Cambridge", region: null, hidden: false }],
        description: "<p><strong>Location:</strong> Remote</p>",
      },
      {
        title: "Operations Associate",
        shortcode: "AAA111",
        url: "https://apply.workable.com/j/AAA111",
        telecommuting: false,
        country: "Mexico",
        city: "Mexico City",
        locations: [{ country: "Mexico", city: "Mexico City", hidden: false }],
      },
    ],
  };
  const url = "https://apply.workable.com/api/v1/widget/accounts/kobotoolbox?details=true";

  it("does not turn a remote role's head office into its scope", async () => {
    // KoboToolbox lists only Cambridge, US for a role open in five countries including Mexico.
    const { ctx: c } = ctx(["kobotoolbox"], { [url]: account });
    const [remote] = await workable.fetch(c);
    expect(remote).toMatchObject({ companyName: "KoboToolbox", workMode: "remote", location: "Remote", country: null, employmentType: "full_time", externalId: "kobotoolbox:D7EB6C2D99" });
    expect(remote!.rawMetadata).toMatchObject({ listed_locations: ["Cambridge, United States"] });
  });

  it("keeps the place of an on-site role", async () => {
    const { ctx: c } = ctx(["kobotoolbox"], { [url]: account });
    const onsite = (await workable.fetch(c)).find((j) => j.externalId === "kobotoolbox:AAA111");
    expect(onsite).toMatchObject({ location: "Mexico City, Mexico", country: "Mexico" });
  });

  it("verifies against the account's current list", async () => {
    const { ctx: c } = ctx(["kobotoolbox"], { "https://apply.workable.com/api/v1/widget/accounts/kobotoolbox": account });
    expect(await workable.verify!(c, { external_id: "kobotoolbox:D7EB6C2D99" } as never)).toBe("active");
    expect(await workable.verify!(c, { external_id: "kobotoolbox:GONE" } as never)).toBe("expired");
  });
});
