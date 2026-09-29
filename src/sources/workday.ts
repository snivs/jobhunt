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

/**
 * Workday's own reference id for each country. It is the same across tenants (HP, Kyndryl, JLL,
 * DXC, Salesforce and Babel all use it for Mexico, verified 2026-09-29), even when the facet that
 * carries it has a tenant-specific name.
 */
const COUNTRY_IDS: Record<string, string> = { mexico: "e2adff9272454660ac4fdb56fc70bb51" };

interface WorkdayFacetValue {
  id?: string;
  descriptor?: string;
  count?: number;
  facetParameter?: string;
  values?: WorkdayFacetValue[];
}
interface WorkdayFacet {
  facetParameter?: string;
  values?: WorkdayFacetValue[];
}

/**
 * The facets that restrict a board to one country. Prefers the country facet (whatever the tenant
 * calls it); a tenant without one gets every `locations` value naming the country instead
 * (Johnson Controls lists "Apodaca-Nuevo Leon-Mexico" and so on). "New Mexico" never counts.
 * Returns null when the board offers neither, so the caller can refuse rather than go worldwide.
 */
export function countryFacets(facets: WorkdayFacet[] | undefined, country: string): Record<string, string[]> | null {
  const id = COUNTRY_IDS[country.toLowerCase()];
  const name = new RegExp(`(?<!new )\\b${country}\\b`, "i");
  let byId: Record<string, string[]> | null = null;
  const byLocation: string[] = [];
  const walk = (param: string | undefined, values: WorkdayFacetValue[] | undefined) => {
    for (const v of values ?? []) {
      if (v.facetParameter) walk(v.facetParameter, v.values);
      else if (id && v.id === id && param) byId ??= { [param]: [id] };
      else if (param === "locations" && v.id && v.descriptor && name.test(v.descriptor)) byLocation.push(v.id);
    }
  };
  for (const f of facets ?? []) walk(f.facetParameter, f.values);
  return byId ?? (byLocation.length ? { locations: byLocation } : null);
}

type Listing = { total?: number; jobPostings?: WorkdayListing[]; facets?: WorkdayFacet[] };

export const workday: JobSource = {
  key: "workday",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const out: RawJob[] = [];
    const boardErrors: string[] = [];
    const perBoard = Number(ctx.config.options.max_per_board ?? 40);
    const withDetails = ctx.config.options.fetch_details !== false;
    // With a country, each board is read as "every posting in that country" and filtered by title
    // locally: a big tenant's worldwide search ranks its Mexican roles out of the first page.
    const country = typeof ctx.config.options.country === "string" ? ctx.config.options.country : null;
    for (const board of ctx.config.boards) {
      const parsed = parseBoard(board);
      if (!parsed) {
        ctx.logger.warn("invalid workday board (expected tenant.wdN/Site)", { board });
        continue;
      }
      const companyName = String(ctx.config.options[`company:${board}`] ?? parsed.tenant);
      const listUrl = `${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}/jobs`;
      const list = (appliedFacets: Record<string, string[]>, searchText: string, offset: number) =>
        ctx.http.getJson<Listing>(listUrl, {
          method: "POST",
          body: JSON.stringify({ appliedFacets, limit: 20, offset, searchText }),
          headers: { "Content-Type": "application/json", Accept: "application/json" },
        });
      const seen = new Set<string>();
      let kept = 0;
      const take = async (j: WorkdayListing): Promise<void> => {
        if (seen.has(j.externalPath)) return;
        seen.add(j.externalPath);
        if (!matchesTerms(ctx.terms, j.title)) return;
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
        kept++;
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
          rawMetadata: { board, path: j.externalPath, postedOn: detail?.postedOn ?? j.postedOn ?? null, additionalLocations: detail?.additionalLocations ?? [], bulletFields: j.bulletFields ?? [] },
        });
      };
      const full = () => kept >= perBoard || out.length >= ctx.limit;
      try {
        if (country) {
          const applied = countryFacets((await list({}, "", 0)).facets, country);
          if (!applied) {
            boardErrors.push(`${board}: no ${country} facet`);
            ctx.logger.warn("workday board has no facet for the configured country; skipped", { board, country });
            continue;
          }
          for (let offset = 0; !full(); offset += 20) {
            const data = await list(applied, "", offset);
            for (const j of data.jobPostings ?? []) {
              await take(j);
              if (full()) break;
            }
            if ((data.jobPostings ?? []).length < 20 || offset + 20 >= (data.total ?? 0)) break;
          }
        } else {
          for (const q of ctx.terms.length ? ctx.terms.slice(0, 4) : [""]) {
            for (const j of (await list({}, q, 0)).jobPostings ?? []) {
              await take(j);
              if (full()) break;
            }
            if (full()) break;
          }
        }
      } catch (err) {
        // One board failing (wrong site name, 422, outage) must not lose the other boards' results.
        ctx.logger.warn("workday board query failed", { board, error: err instanceof Error ? err.message : String(err) });
        boardErrors.push(`${board}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
    }
    if (out.length === 0 && boardErrors.length > 0) throw new Error(`All Workday boards failed: ${boardErrors.join(" | ")}`);
    if (boardErrors.length > 0) ctx.logger.warn("some workday boards failed", { errors: boardErrors });
    return out.slice(0, ctx.limit);
  },
  async verify(ctx, job) {
    const [board, ...rest] = (job.external_id ?? "").split(":");
    const parsed = board ? parseBoard(board) : null;
    // The id is usually the requisition number; the posting's path is kept in the metadata.
    let path = rest.join(":");
    if (!path.startsWith("/")) {
      try {
        path = String((JSON.parse(job.raw_metadata_json ?? "{}") as { path?: unknown }).path ?? "");
      } catch {
        path = "";
      }
    }
    if (!parsed || !path.startsWith("/")) return "unknown";
    try {
      await ctx.http.getJson(`${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}${path}`);
      return "active";
    } catch (err) {
      return err instanceof Error && /HTTP 404/.test(err.message) ? "expired" : "unknown";
    }
  },
};
