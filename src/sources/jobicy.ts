import type { RawJob } from "../core/normalize.js";
import type { EmploymentType, Seniority } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext, unixOrIsoToIso } from "./types.js";

interface JobicyJob {
  id: number;
  url: string;
  jobSlug: string;
  jobTitle: string;
  companyName: string;
  jobIndustry?: string[];
  jobType?: string[];
  /** Remote scope as Jobicy states it: "Mexico", "Latin America", "Anywhere", "USA Only", ... */
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
}

const SENIORITY: Record<string, Seniority> = {
  intern: "intern",
  junior: "junior",
  "entry-level": "junior",
  mid: "mid",
  "mid-level": "mid",
  senior: "senior",
  staff: "staff",
  principal: "principal",
  lead: "lead",
  manager: "manager",
  director: "director",
  executive: "executive",
};

const EMPLOYMENT: Record<string, EmploymentType> = {
  "full-time": "full_time",
  "part-time": "part_time",
  contract: "contract",
  freelance: "freelance",
  internship: "internship",
  temporary: "contract",
};

/**
 * Jobicy public API: https://jobi.cy/apidocs - documented, no key required.
 *
 * Its terms ask that Jobicy be credited and that application links point at the original posting;
 * we store `url` (the Jobicy posting, which redirects to the employer) and never re-host content.
 *
 * The reason this source earns its place: `geo` is a first-class filter, so we can ask for
 * Mexico-eligible and LATAM-eligible remote work directly instead of discovering a worldwide corpus
 * and rejecting most of it afterwards. Configure the geos through `options.geos`.
 */
export const jobicy: JobSource = {
  key: "jobicy",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://jobicy.com/api/v2/remote-jobs";
    const geos = (ctx.config.options.geos as string[] | undefined) ?? ["mexico", "latam", "anywhere"];
    const count = Number(ctx.config.options.count ?? 50);

    const out: RawJob[] = [];
    const seen = new Set<number>();

    for (const geo of geos) {
      const url = `${base}?count=${count}${geo ? `&geo=${encodeURIComponent(geo)}` : ""}`;
      const data = await ctx.http.getJson<{ jobs?: JobicyJob[] }>(url);
      for (const j of data.jobs ?? []) {
        // The same posting can appear under several geos (e.g. "mexico" and "anywhere").
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        if (!matchesTerms(ctx.terms, j.jobTitle, (j.jobIndustry ?? []).join(" "))) continue;

        const level = (j.jobLevel ?? "").trim().toLowerCase();
        const type = (j.jobType ?? [])[0]?.trim().toLowerCase() ?? "";

        out.push({
          sourceKey: "jobicy",
          externalId: String(j.id),
          url: j.url,
          title: j.jobTitle,
          companyName: j.companyName || null,
          location: j.jobGeo || null,
          // Every Jobicy posting is remote by construction; jobGeo is the scope, not an office.
          workMode: "remote",
          remoteScope: j.jobGeo || null,
          description: j.jobDescription || j.jobExcerpt || null,
          postedAt: unixOrIsoToIso(j.pubDate),
          seniority: SENIORITY[level] ?? null,
          employmentType: EMPLOYMENT[type] ?? null,
          rawMetadata: { geo_queried: geo, jobGeo: j.jobGeo ?? null, jobLevel: j.jobLevel ?? null, industry: j.jobIndustry ?? [] },
        });
        if (out.length >= ctx.limit) return out;
      }
    }
    return out;
  },
};
