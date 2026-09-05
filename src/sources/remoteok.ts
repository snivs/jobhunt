import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext, unixOrIsoToIso } from "./types.js";

interface RemoteOkJob {
  id?: string;
  slug?: string;
  url?: string;
  position?: string;
  company?: string;
  location?: string;
  description?: string;
  date?: string;
  epoch?: number;
  salary_min?: number;
  salary_max?: number;
  tags?: string[];
  legal?: string;
}

/** Public JSON feed https://remoteok.com/api (the feed's own legal notice asks for attribution and a User-Agent). */
export const remoteok: JobSource = {
  key: "remoteok",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const data = await ctx.http.getJson<RemoteOkJob[]>(ctx.config.base_url ?? "https://remoteok.com/api");
    const out: RawJob[] = [];
    for (const j of data) {
      if (!j.position || !j.url) continue; // first element is the legal notice
      if (!matchesTerms(ctx.terms, j.position, (j.tags ?? []).join(" "))) continue;
      const hasSalary = (j.salary_min ?? 0) > 0 || (j.salary_max ?? 0) > 0;
      out.push({
        sourceKey: "remoteok",
        externalId: j.id ?? j.slug ?? null,
        url: j.url,
        title: j.position,
        companyName: j.company ?? null,
        location: j.location || "Remote",
        remoteScope: j.location || "Worldwide",
        workMode: "remote",
        description: j.description ?? null,
        postedAt: unixOrIsoToIso(j.epoch ?? j.date),
        salary: hasSalary ? { min: j.salary_min || null, max: j.salary_max || null, currency: "USD", period: "year", text: `USD ${j.salary_min}-${j.salary_max}` } : null,
        rawMetadata: { tags: j.tags ?? [], attribution: "https://remoteok.com" },
      });
      if (out.length >= ctx.limit) break;
    }
    return out;
  },
};
