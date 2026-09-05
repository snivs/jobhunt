import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext, unixOrIsoToIso } from "./types.js";

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

/** Public job board API: https://www.arbeitnow.com/api/job-board-api (documented, no key, paginated). */
export const arbeitnow: JobSource = {
  key: "arbeitnow",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://www.arbeitnow.com/api/job-board-api";
    const out: RawJob[] = [];
    const maxPages = Number(ctx.config.options.max_pages ?? 5);
    for (let page = 1; page <= maxPages; page++) {
      const data = await ctx.http.getJson<{ data: ArbeitnowJob[]; links?: { next?: string | null } }>(`${base}?page=${page}`);
      for (const j of data.data ?? []) {
        if (!matchesTerms(ctx.terms, j.title, (j.tags ?? []).join(" "))) continue;
        const types = (j.job_types ?? []).map((t) => t.toLowerCase());
        out.push({
          sourceKey: "arbeitnow",
          externalId: j.slug,
          url: j.url,
          title: j.title,
          companyName: j.company_name,
          location: j.location || null,
          workMode: j.remote ? "remote" : null,
          description: j.description,
          postedAt: unixOrIsoToIso(j.created_at),
          employmentType: types.includes("full time") || types.includes("full-time") ? "full_time" : types.includes("part time") ? "part_time" : types.includes("internship") ? "internship" : null,
          rawMetadata: { tags: j.tags ?? [], job_types: j.job_types ?? [] },
        });
        if (out.length >= ctx.limit) return out;
      }
      if (!data.links?.next || (data.data ?? []).length === 0) break;
    }
    return out;
  },
};
