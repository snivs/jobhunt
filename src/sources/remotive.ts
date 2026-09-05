import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext } from "./types.js";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
  tags?: string[];
}

function jobType(t: string | undefined): RawJob["employmentType"] {
  switch ((t ?? "").toLowerCase()) {
    case "full_time":
      return "full_time";
    case "part_time":
      return "part_time";
    case "contract":
    case "freelance":
      return "contract";
    case "internship":
      return "internship";
    default:
      return null;
  }
}

/** Parses free-text salary such as "$90,000 - $120,000" or "USD 90k-120k/year". */
export function parseSalaryText(text: string | null | undefined): RawJob["salary"] {
  if (!text) return null;
  const t = text.replace(/,/g, "");
  const currency = /usd|\$/i.test(t) ? "USD" : /eur|€/i.test(t) ? "EUR" : /gbp|£/i.test(t) ? "GBP" : /mxn/i.test(t) ? "MXN" : /cad/i.test(t) ? "CAD" : null;
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(k)?/gi)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1)).filter((n) => n >= 1000);
  if (!currency || nums.length === 0) return { text };
  const period = /hour|\/h\b|hr\b/i.test(t) ? "hour" : /month|\/m\b|mes/i.test(t) ? "month" : "year";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max, currency, period, text };
}

/** Official public API: https://remotive.com/api/remote-jobs (documented, no key). */
export const remotive: JobSource = {
  key: "remotive",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://remotive.com/api/remote-jobs";
    const out: RawJob[] = [];
    const queries = ctx.terms.length ? ctx.terms : [""];
    const seen = new Set<number>();
    for (const q of queries.slice(0, 6)) {
      const url = `${base}?limit=${Math.min(ctx.limit, 200)}${q ? `&search=${encodeURIComponent(q)}` : ""}`;
      const data = await ctx.http.getJson<{ jobs: RemotiveJob[] }>(url);
      for (const j of data.jobs ?? []) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        if (!matchesTerms(ctx.terms, j.title, j.category, (j.tags ?? []).join(" "))) continue;
        out.push({
          sourceKey: "remotive",
          externalId: String(j.id),
          url: j.url,
          title: j.title,
          companyName: j.company_name,
          location: j.candidate_required_location || "Remote",
          remoteScope: j.candidate_required_location || "Worldwide",
          workMode: "remote",
          description: j.description,
          postedAt: j.publication_date,
          employmentType: jobType(j.job_type),
          salary: parseSalaryText(j.salary),
          rawMetadata: { category: j.category, tags: j.tags ?? [] },
        });
      }
      if (out.length >= ctx.limit) break;
    }
    return out.slice(0, ctx.limit);
  },
  async verify(ctx, job) {
    const id = job.external_id;
    if (!id) return "unknown";
    const data = await ctx.http.getJson<{ jobs: RemotiveJob[] }>(`${ctx.config.base_url ?? "https://remotive.com/api/remote-jobs"}?limit=1&search=${encodeURIComponent(job.title)}`);
    return data.jobs?.some((j) => String(j.id) === id) ? "active" : "unknown";
  },
};
