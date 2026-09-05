import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext, unixOrIsoToIso } from "./types.js";

export interface HimalayasJob {
  title: string;
  excerpt?: string;
  description?: string;
  companyName?: string;
  companySlug?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string | null;
  currency?: string | null;
  seniority?: string[];
  locationRestrictions?: string[];
  timezoneRestrictions?: number[];
  categories?: string[];
  parentCategories?: string[];
  pubDate?: number;
  expiryDate?: number;
  applicationLink?: string;
  guid?: string;
}

interface HimalayasResponse {
  jobs?: HimalayasJob[];
  totalCount?: number;
  nextCursor?: string | null;
}

export function mapHimalayasJob(j: HimalayasJob): RawJob {
  const restrictions = j.locationRestrictions ?? [];
  const scope = restrictions.length ? restrictions.join(", ") : "Worldwide";
  const et = (j.employmentType ?? "").toLowerCase();
  const seniorityTag = (j.seniority ?? []).map((s) => s.toLowerCase()).join(" ");
  const hasSalary = (j.minSalary ?? 0) > 0 || (j.maxSalary ?? 0) > 0;
  const period = (j.salaryPeriod ?? "annual").toLowerCase();
  return {
    sourceKey: "himalayas",
    externalId: j.guid ?? j.applicationLink ?? null,
    url: j.applicationLink ?? j.guid ?? "",
    title: j.title,
    companyName: j.companyName ?? null,
    location: `Remote (${scope})`,
    remoteScope: scope,
    country: restrictions.length === 1 ? restrictions[0]! : null,
    workMode: "remote",
    description: j.description ?? j.excerpt ?? null,
    postedAt: unixOrIsoToIso(j.pubDate),
    employmentType: et.includes("full") ? "full_time" : et.includes("part") ? "part_time" : et.includes("contract") ? "contract" : et.includes("intern") ? "internship" : null,
    seniority: /lead|principal|staff/.test(seniorityTag) ? (seniorityTag.includes("staff") ? "staff" : seniorityTag.includes("principal") ? "principal" : "lead") : /senior/.test(seniorityTag) ? "senior" : /mid/.test(seniorityTag) ? "mid" : /entry|junior/.test(seniorityTag) ? "junior" : null,
    salary: hasSalary && j.currency ? { min: j.minSalary ?? null, max: j.maxSalary ?? null, currency: j.currency, period: period.startsWith("month") ? "month" : period.startsWith("hour") ? "hour" : "year" } : null,
    rawMetadata: { seniority: j.seniority ?? [], categories: j.categories ?? [], parentCategories: j.parentCategories ?? [], timezoneRestrictions: j.timezoneRestrictions ?? [], expiryDate: unixOrIsoToIso(j.expiryDate), attribution: "Originally posted on Himalayas (https://himalayas.app)" },
  };
}

/** Public jobs API: https://himalayas.app/jobs/api (cursor pagination, newest first). */
export const himalayas: JobSource = {
  key: "himalayas",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://himalayas.app/jobs/api";
    const maxPages = Number(ctx.config.options.max_pages ?? 5);
    const pageSize = Number(ctx.config.options.page_size ?? 100);
    const out: RawJob[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const url = `${base}?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const data: HimalayasResponse = await ctx.http.getJson<HimalayasResponse>(url);
      for (const j of data.jobs ?? []) {
        if (!j.title || !(j.applicationLink || j.guid)) continue;
        if (!matchesTerms(ctx.terms, j.title, (j.categories ?? []).join(" "), (j.parentCategories ?? []).join(" "))) continue;
        out.push(mapHimalayasJob(j));
        if (out.length >= ctx.limit) return out;
      }
      if (!data.nextCursor || (data.jobs ?? []).length === 0) break;
      cursor = data.nextCursor;
    }
    return out;
  },
};
