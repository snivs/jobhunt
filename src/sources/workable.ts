import type { RawJob } from "../core/normalize.js";
import { htmlToText } from "../core/normalize.js";
import { matchesTerms, type JobSource } from "./types.js";

/**
 * Workable public careers widget: https://apply.workable.com/api/v1/widget/accounts/<account>
 *
 * The read-only endpoint Workable offers for embedding a company's openings on its own site;
 * `details=true` includes descriptions, so a whole board is one request. apply.workable.com's
 * robots.txt allows everything. Added 2026-09-27 (KoboToolbox publishes there).
 *
 * Boards are the account slug ("kobotoolbox" for apply.workable.com/kobotoolbox).
 */

interface WorkableLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  hidden?: boolean;
}

interface WorkableJob {
  title: string;
  shortcode: string;
  url: string;
  application_url?: string;
  employment_type?: string | null;
  telecommuting?: boolean;
  department?: string | null;
  published_on?: string | null;
  created_at?: string | null;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  locations?: WorkableLocation[];
  description?: string | null;
}

function place(l: WorkableLocation): string {
  return [l.city, l.region, l.country].filter((p) => p && String(p).trim() !== "").join(", ");
}

function employmentType(raw: string | null | undefined): RawJob["employmentType"] {
  if (!raw) return null;
  if (/full/i.test(raw)) return "full_time";
  if (/part/i.test(raw)) return "part_time";
  if (/contract|temporary/i.test(raw)) return "contract";
  if (/intern/i.test(raw)) return "internship";
  return null;
}

export const workable: JobSource = {
  key: "workable",
  async fetch(ctx): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (const board of ctx.config.boards) {
      const data = await ctx.http.getJson<{ name?: string; jobs?: WorkableJob[] }>(
        `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}?details=true`,
      );
      for (const j of data.jobs ?? []) {
        if (out.length >= ctx.limit) break;
        if (!matchesTerms(ctx.terms, j.title, j.department ?? "")) continue;
        const visible = (j.locations ?? []).filter((l) => !l.hidden);
        const places = visible.map(place).filter(Boolean);
        // The widget often lists only the head office for a remote role (KoboToolbox shows
        // "Cambridge, United States" for a job open in five countries). One place on a remote role
        // is therefore not a scope; several are.
        const location = j.telecommuting ? (places.length > 1 ? places.join("; ") : "Remote") : places.join("; ") || place(j) || null;
        out.push({
          sourceKey: "workable",
          externalId: `${board}:${j.shortcode}`,
          url: j.url,
          title: j.title,
          companyName: String(ctx.config.options[`company:${board}`] ?? data.name ?? board),
          location,
          country: j.telecommuting ? null : (j.country ?? null),
          workMode: j.telecommuting ? "remote" : null,
          description: j.description ? htmlToText(j.description) : null,
          postedAt: j.published_on ?? j.created_at ?? null,
          employmentType: employmentType(j.employment_type),
          rawMetadata: { board, department: j.department ?? null, listed_locations: places, application_url: j.application_url ?? null },
        });
      }
    }
    return out;
  },
  async verify(ctx, job) {
    const [board, code] = (job.external_id ?? "").split(":");
    if (!board || !code) return "unknown";
    try {
      const data = await ctx.http.getJson<{ jobs?: WorkableJob[] }>(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}`);
      return (data.jobs ?? []).some((j) => j.shortcode === code) ? "active" : "expired";
    } catch (err) {
      return err instanceof Error && /HTTP 404/.test(err.message) ? "expired" : "unknown";
    }
  },
};
