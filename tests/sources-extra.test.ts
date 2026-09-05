import { describe, expect, it } from "vitest";
import { mapHimalayasJob } from "../src/sources/himalayas.js";
import { parseBoard } from "../src/sources/workday.js";
import { parseRssItems, splitWwrTitle } from "../src/sources/wwr.js";

describe("We Work Remotely RSS", () => {
  it("parses items with CDATA and custom fields", () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title>Acme: Senior Backend Engineer</title>
      <region>Anywhere in the World</region>
      <category>Back-End Programming</category>
      <type>Full-Time</type>
      <description><![CDATA[<p>Build <b>APIs</b></p>]]></description>
      <pubDate>Fri, 05 Sep 2026 10:00:00 +0000</pubDate>
      <link>https://weworkremotely.com/remote-jobs/acme-senior-backend-engineer</link>
      <guid>https://weworkremotely.com/remote-jobs/acme-senior-backend-engineer</guid>
    </item><item><title>NoColon Title</title><link>https://x/y</link></item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("<p>Build <b>APIs</b></p>");
    expect(items[0]!.region).toBe("Anywhere in the World");
    expect(splitWwrTitle(items[0]!.title!)).toEqual({ company: "Acme", title: "Senior Backend Engineer" });
    expect(splitWwrTitle("NoColon Title")).toEqual({ company: null, title: "NoColon Title" });
  });
});

describe("Himalayas mapping", () => {
  it("maps salary, seniority and restrictions", () => {
    const raw = mapHimalayasJob({
      title: "Staff Software Engineer",
      companyName: "Beta",
      employmentType: "Full Time",
      minSalary: 150000,
      maxSalary: 200000,
      salaryPeriod: "annual",
      currency: "USD",
      seniority: ["Staff", "Senior"],
      locationRestrictions: ["United States", "Mexico"],
      pubDate: 1788575295,
      applicationLink: "https://himalayas.app/companies/beta/jobs/staff",
      guid: "https://himalayas.app/companies/beta/jobs/staff",
    });
    expect(raw).toMatchObject({ sourceKey: "himalayas", workMode: "remote", remoteScope: "United States, Mexico", employmentType: "full_time", seniority: "staff" });
    expect(raw.salary).toMatchObject({ min: 150000, max: 200000, currency: "USD", period: "year" });
    expect(raw.postedAt).toBe(new Date(1788575295 * 1000).toISOString());
    const noSalary = mapHimalayasJob({ title: "x", applicationLink: "https://h/x", minSalary: null, maxSalary: null, currency: null, locationRestrictions: [] });
    expect(noSalary.salary).toBeNull();
    expect(noSalary.remoteScope).toBe("Worldwide");
  });
});

describe("Workday board parsing", () => {
  it("accepts tenant.wdN/Site and rejects other shapes", () => {
    expect(parseBoard("nvidia.wd5/NVIDIAExternalCareerSite")).toEqual({ host: "https://nvidia.wd5.myworkdayjobs.com", tenant: "nvidia", site: "NVIDIAExternalCareerSite" });
    expect(parseBoard("https://nvidia.wd5.myworkdayjobs.com/x")).toBeNull();
  });
});
