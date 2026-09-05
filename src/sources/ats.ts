import type { RawJob } from "../core/normalize.js";
import { htmlToText } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext } from "./types.js";

/**
 * ATS public job-board APIs. Each company exposes its board under a token configured in
 * config/jobhunt.yaml (`boards: [...]`). These are official, documented, read-only endpoints.
 * Submission through them requires the company's own API key (Greenhouse/Lever) or is
 * form-based (Ashby); it is not automated here.
 */

// ── Greenhouse: https://developers.greenhouse.io/job-board.html ─────────────────────────────
interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  first_published?: string;
  location?: { name: string };
  content?: string;
  departments?: Array<{ name: string }>;
  offices?: Array<{ name: string }>;
  metadata?: Array<{ name: string; value: unknown }>;
}

function decodeEntities(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

export const greenhouse: JobSource = {
  key: "greenhouse",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://boards-api.greenhouse.io/v1/boards";
    const out: RawJob[] = [];
    for (const board of ctx.config.boards) {
      const data = await ctx.http.getJson<{ jobs: GreenhouseJob[] }>(`${base}/${encodeURIComponent(board)}/jobs?content=true`);
      for (const j of data.jobs ?? []) {
        if (!matchesTerms(ctx.terms, j.title, (j.departments ?? []).map((d) => d.name).join(" "))) continue;
        const location = j.location?.name ?? ((j.offices ?? []).map((o) => o.name).join(", ") || null);
        out.push({
          sourceKey: "greenhouse",
          externalId: `${board}:${j.id}`,
          url: j.absolute_url,
          title: j.title,
          companyName: String(ctx.config.options[`company:${board}`] ?? board),
          location,
          workMode: /remote/i.test(location ?? "") ? "remote" : null,
          description: j.content ? htmlToText(decodeEntities(j.content)) : null,
          postedAt: j.first_published ?? j.updated_at,
          rawMetadata: { board, departments: (j.departments ?? []).map((d) => d.name), metadata: j.metadata ?? [] },
        });
      }
    }
    return out.slice(0, ctx.limit);
  },
  async verify(ctx, job) {
    const [board, id] = (job.external_id ?? "").split(":");
    if (!board || !id) return "unknown";
    try {
      await ctx.http.getJson(`${ctx.config.base_url ?? "https://boards-api.greenhouse.io/v1/boards"}/${board}/jobs/${id}`);
      return "active";
    } catch (err) {
      return err instanceof Error && /HTTP 404/.test(err.message) ? "expired" : "unknown";
    }
  },
};

// ── Lever: https://github.com/lever/postings-api ────────────────────────────────────────────
interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt: number;
  country?: string;
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
  categories?: { location?: string; team?: string; commitment?: string; department?: string };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export const lever: JobSource = {
  key: "lever",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://api.lever.co/v0/postings";
    const out: RawJob[] = [];
    for (const site of ctx.config.boards) {
      const data = await ctx.http.getJson<LeverPosting[]>(`${base}/${encodeURIComponent(site)}?mode=json`);
      for (const p of data) {
        if (!matchesTerms(ctx.terms, p.text, p.categories?.team, p.categories?.department)) continue;
        const wp = (p.workplaceType ?? "").toLowerCase();
        const sr = p.salaryRange;
        out.push({
          sourceKey: "lever",
          externalId: `${site}:${p.id}`,
          url: p.hostedUrl,
          title: p.text,
          companyName: String(ctx.config.options[`company:${site}`] ?? site),
          location: p.categories?.location ?? null,
          country: p.country ?? null,
          workMode: wp === "remote" ? "remote" : wp === "hybrid" ? "hybrid" : wp === "onsite" || wp === "on-site" ? "onsite" : null,
          description: p.descriptionPlain ?? (p.description ? htmlToText(p.description) : null),
          postedAt: new Date(p.createdAt).toISOString(),
          employmentType: /full/i.test(p.categories?.commitment ?? "") ? "full_time" : /part/i.test(p.categories?.commitment ?? "") ? "part_time" : /contract/i.test(p.categories?.commitment ?? "") ? "contract" : null,
          salary: sr && (sr.min || sr.max) ? { min: sr.min ?? null, max: sr.max ?? null, currency: sr.currency ?? null, period: (sr.interval ?? "per-year-salary").includes("year") ? "year" : (sr.interval ?? "").includes("month") ? "month" : (sr.interval ?? "").includes("hour") ? "hour" : "year" } : null,
          rawMetadata: { site, team: p.categories?.team, department: p.categories?.department, applyUrl: p.applyUrl },
        });
      }
    }
    return out.slice(0, ctx.limit);
  },
  async verify(ctx, job) {
    const [site, id] = (job.external_id ?? "").split(":");
    if (!site || !id) return "unknown";
    try {
      await ctx.http.getJson(`${ctx.config.base_url ?? "https://api.lever.co/v0/postings"}/${site}/${id}`);
      return "active";
    } catch (err) {
      return err instanceof Error && /HTTP 404/.test(err.message) ? "expired" : "unknown";
    }
  },
};

// ── Ashby: https://developers.ashbyhq.com/docs/public-job-posting-api ───────────────────────
interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: Array<{ location: string }>;
  isRemote?: boolean;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  jobUrl: string;
  applyUrl?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  compensation?: { compensationTierSummary?: string; summaryComponents?: Array<{ compensationType: string; minValue?: number; maxValue?: number; currencyCode?: string; interval?: string }> };
}

export const ashby: JobSource = {
  key: "ashby",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://api.ashbyhq.com/posting-api/job-board";
    const out: RawJob[] = [];
    for (const board of ctx.config.boards) {
      const data = await ctx.http.getJson<{ jobs: AshbyJob[] }>(`${base}/${encodeURIComponent(board)}?includeCompensation=true`);
      for (const j of data.jobs ?? []) {
        if (!matchesTerms(ctx.terms, j.title, j.department, j.team)) continue;
        const salaryComp = j.compensation?.summaryComponents?.find((c) => c.compensationType === "Salary");
        const et = (j.employmentType ?? "").toLowerCase();
        out.push({
          sourceKey: "ashby",
          externalId: `${board}:${j.id}`,
          url: j.jobUrl,
          title: j.title,
          companyName: String(ctx.config.options[`company:${board}`] ?? board),
          location: j.location ?? null,
          workMode: j.isRemote ? "remote" : null,
          description: j.descriptionPlain ?? (j.descriptionHtml ? htmlToText(j.descriptionHtml) : null),
          postedAt: j.publishedAt ?? null,
          employmentType: et.includes("full") ? "full_time" : et.includes("part") ? "part_time" : et.includes("contract") ? "contract" : et.includes("intern") ? "internship" : null,
          salary: salaryComp && (salaryComp.minValue || salaryComp.maxValue) ? { min: salaryComp.minValue ?? null, max: salaryComp.maxValue ?? null, currency: salaryComp.currencyCode ?? null, period: (salaryComp.interval ?? "").toLowerCase().includes("month") ? "month" : (salaryComp.interval ?? "").toLowerCase().includes("hour") ? "hour" : "year", text: j.compensation?.compensationTierSummary ?? null } : j.compensation?.compensationTierSummary ? { text: j.compensation.compensationTierSummary } : null,
          rawMetadata: { board, department: j.department, team: j.team, applyUrl: j.applyUrl },
        });
      }
    }
    return out.slice(0, ctx.limit);
  },
};
