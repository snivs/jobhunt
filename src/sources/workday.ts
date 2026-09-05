import type { RawJob } from "../core/normalize.js";
import { htmlToText } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext } from "./types.js";

/**
 * Workday-hosted career sites (NVIDIA, AMD and many others) serve their own job list through a
 * public, unauthenticated JSON endpoint used by the site's front-end:
 *   POST https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *   GET  https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
 * Read-only, low volume, respecting each board's rate limits. No login, no CAPTCHA, no evasion.
 * Boards are configured as "tenant.wdN/SiteName" (e.g. "nvidia.wd5/NVIDIAExternalCareerSite").
 */
interface WorkdayListing {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}
interface WorkdayDetail {
  jobPostingInfo?: {
    id?: string;
    title?: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    postedOn?: string;
    startDate?: string;
    timeType?: string;
    jobReqId?: string;
    externalUrl?: string;
    remoteType?: string;
    country?: { descriptor?: string };
  };
  hiringOrganization?: { name?: string; url?: string };
}

export function parseBoard(board: string): { host: string; tenant: string; site: string } | null {
  const m = /^([a-z0-9-]+)\.(wd\d+)\/([A-Za-z0-9_-]+)$/i.exec(board.trim());
  if (!m) return null;
  return { host: `https://${m[1]}.${m[2]}.myworkdayjobs.com`, tenant: m[1]!, site: m[3]! };
}

export const workday: JobSource = {
  key: "workday",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const out: RawJob[] = [];
    const perBoard = Number(ctx.config.options.max_per_board ?? 40);
    const withDetails = ctx.config.options.fetch_details !== false;
    for (const board of ctx.config.boards) {
      const parsed = parseBoard(board);
      if (!parsed) {
        ctx.logger.warn("invalid workday board (expected tenant.wdN/Site)", { board });
        continue;
      }
      const companyName = String(ctx.config.options[`company:${board}`] ?? parsed.tenant);
      const queries = ctx.terms.length ? ctx.terms.slice(0, 4) : [""];
      const seen = new Set<string>();
      for (const q of queries) {
        const body = JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: q });
        const data = await ctx.http.getJson<{ total?: number; jobPostings?: WorkdayListing[] }>(`${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}/jobs`, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
        });
        for (const j of data.jobPostings ?? []) {
          if (seen.has(j.externalPath)) continue;
          seen.add(j.externalPath);
          if (!matchesTerms(ctx.terms, j.title)) continue;
          let detail: WorkdayDetail["jobPostingInfo"] | undefined;
          if (withDetails) {
            try {
              detail = (await ctx.http.getJson<WorkdayDetail>(`${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}${j.externalPath}`)).jobPostingInfo;
            } catch (err) {
              ctx.logger.warn("workday detail fetch failed", { board, path: j.externalPath, error: err instanceof Error ? err.message : String(err) });
            }
          }
          const location = detail?.location ?? j.locationsText ?? null;
          const remote = /remote/i.test(`${detail?.remoteType ?? ""} ${location ?? ""}`);
          out.push({
            sourceKey: "workday",
            externalId: `${board}:${detail?.jobReqId ?? j.externalPath}`,
            url: detail?.externalUrl ?? `${parsed.host}/${parsed.site}${j.externalPath}`,
            title: detail?.title ?? j.title,
            companyName,
            location,
            country: detail?.country?.descriptor ?? null,
            workMode: remote ? "remote" : null,
            description: detail?.jobDescription ? htmlToText(detail.jobDescription) : null,
            postedAt: detail?.startDate ?? null,
            employmentType: /full/i.test(detail?.timeType ?? "") ? "full_time" : /part/i.test(detail?.timeType ?? "") ? "part_time" : null,
            rawMetadata: { board, postedOn: detail?.postedOn ?? j.postedOn ?? null, additionalLocations: detail?.additionalLocations ?? [], bulletFields: j.bulletFields ?? [] },
          });
          if (seen.size >= perBoard || out.length >= ctx.limit) break;
        }
        if (seen.size >= perBoard || out.length >= ctx.limit) break;
      }
    }
    return out.slice(0, ctx.limit);
  },
  async verify(ctx, job) {
    const [board, ...rest] = (job.external_id ?? "").split(":");
    const parsed = board ? parseBoard(board) : null;
    const path = rest.join(":");
    if (!parsed || !path.startsWith("/")) return "unknown";
    try {
      await ctx.http.getJson(`${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}${path}`);
      return "active";
    } catch (err) {
      return err instanceof Error && /HTTP 404/.test(err.message) ? "expired" : "unknown";
    }
  },
};
