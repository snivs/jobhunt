import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext, unixOrIsoToIso } from "./types.js";

interface WorkingNomadsJob {
  url: string;
  title: string;
  description?: string;
  company_name?: string;
  category_name?: string;
  /** Comma-separated keywords, not an array. */
  tags?: string;
  /** The remote scope in prose: "Remote, USA Only", "Europe, LATAM, APAC, the U.S., Canada", ... */
  location?: string;
  pub_date?: string;
}

/**
 * Working Nomads public feed: https://www.workingnomads.com/api/exposed_jobs/ - a single JSON array,
 * no key, no pagination. Their robots.txt allows everything and the path is deliberately exposed.
 *
 * Why this source earns its place: `location` carries the employer's own scope wording, which is
 * exactly what the `workable_from` hard constraint consumes. Postings scoped to "USA Only" are
 * rejected with a readable reason instead of surfacing, and ones naming LATAM survive.
 */
export const workingNomads: JobSource = {
  key: "workingnomads",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://www.workingnomads.com/api/exposed_jobs/";
    const jobs = await ctx.http.getJson<WorkingNomadsJob[]>(base);

    const out: RawJob[] = [];
    for (const j of jobs ?? []) {
      if (!j.url || !j.title) continue;
      const tags = (j.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!matchesTerms(ctx.terms, j.title, tags.join(" "), j.category_name)) continue;

      // URLs look like https://www.workingnomads.com/job/go/1891955/ - the digits are the id.
      const id = j.url.match(/\/(\d+)\/?$/)?.[1] ?? j.url;

      out.push({
        sourceKey: "workingnomads",
        externalId: id,
        url: j.url,
        title: j.title,
        companyName: j.company_name || null,
        location: j.location || null,
        workMode: "remote",
        remoteScope: j.location || null,
        description: j.description || null,
        postedAt: unixOrIsoToIso(j.pub_date),
        rawMetadata: { category: j.category_name ?? null, tags },
      });
      if (out.length >= ctx.limit) return out;
    }
    return out;
  },
};
