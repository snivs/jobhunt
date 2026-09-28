import type { RawJob, WorkMode } from "../core/normalize.js";
import { htmlToText } from "../core/normalize.js";
import { matchesTerms, type JobSource } from "./types.js";

/**
 * BambooHR public careers pages: https://<company>.bamboohr.com/careers
 *
 * The careers site is backed by two read-only JSON endpoints that its own page calls: the list at
 * /careers/list and one opening at /careers/<id>/detail. robots.txt disallows only the legacy
 * embed scripts, not these. Added 2026-09-27 because the Mexican fintechs that hire most (Bitso,
 * Konfío) publish there and nowhere with an API we already read.
 *
 * Boards are the company subdomain ("bitso" for bitso.bamboohr.com).
 */

interface BambooListItem {
  id: string;
  jobOpeningName: string;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
  location?: { city?: string | null; state?: string | null } | null;
  atsLocation?: { country?: string | null; state?: string | null; city?: string | null } | null;
  isRemote?: boolean | null;
  /** "0" in office, "1" remote, "2" hybrid, as the careers page renders them. */
  locationType?: string | null;
}

interface BambooDetail {
  jobOpeningShareUrl?: string;
  jobOpeningName: string;
  description?: string | null;
  datePosted?: string | null;
  location?: { city?: string | null; state?: string | null; addressCountry?: string | null } | null;
  atsLocation?: { country?: string | null; state?: string | null; city?: string | null } | null;
  locationType?: string | null;
  employmentStatusLabel?: string | null;
}

function workModeOf(type: string | null | undefined, isRemote: boolean | null | undefined): WorkMode | null {
  if (isRemote || type === "1") return "remote";
  if (type === "2") return "hybrid";
  if (type === "0") return "onsite";
  return null;
}

interface Placed {
  location?: { city?: string | null; state?: string | null; addressCountry?: string | null } | null;
  atsLocation?: { country?: string | null; state?: string | null; city?: string | null } | null;
}

function placeOf(item: Placed): { location: string | null; country: string | null } {
  const country = item.atsLocation?.country ?? item.location?.addressCountry ?? null;
  const parts = [item.location?.city ?? item.atsLocation?.city, item.location?.state ?? item.atsLocation?.state, country].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return { location: parts.length ? parts.join(", ") : null, country };
}

export const bamboohr: JobSource = {
  key: "bamboohr",
  async fetch(ctx): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (const board of ctx.config.boards) {
      const base = `https://${encodeURIComponent(board)}.bamboohr.com/careers`;
      const list = await ctx.http.getJson<{ result?: BambooListItem[] }>(`${base}/list`);
      for (const item of list.result ?? []) {
        if (out.length >= ctx.limit) break;
        if (!matchesTerms(ctx.terms, item.jobOpeningName, item.departmentLabel ?? "")) continue;
        // The list has no description; the detail call is made only for postings that passed the
        // term filter, so a board of sales roles costs one request, not one per role.
        const detail = (await ctx.http.getJson<{ result?: { jobOpening?: BambooDetail } }>(`${base}/${encodeURIComponent(item.id)}/detail`)).result?.jobOpening;
        const mode = workModeOf(detail?.locationType ?? item.locationType, item.isRemote);
        const { location, country } = placeOf(detail ?? item);
        out.push({
          sourceKey: "bamboohr",
          externalId: `${board}:${item.id}`,
          url: detail?.jobOpeningShareUrl ?? `${base}/${item.id}`,
          title: item.jobOpeningName,
          companyName: String(ctx.config.options[`company:${board}`] ?? board),
          // A remote opening with no stated place says nothing about scope; leave that to the body.
          location: location ?? (mode === "remote" ? "Remote" : null),
          country: mode === "remote" ? null : country,
          workMode: mode,
          description: detail?.description ? htmlToText(detail.description) : null,
          postedAt: detail?.datePosted ?? null,
          rawMetadata: { board, department: item.departmentLabel ?? null, employmentStatus: item.employmentStatusLabel ?? null, locationType: item.locationType ?? null },
        });
      }
    }
    return out;
  },
  async verify(ctx, job) {
    const [board, id] = (job.external_id ?? "").split(":");
    if (!board || !id) return "unknown";
    try {
      const d = await ctx.http.getJson<{ result?: { jobOpening?: { jobOpeningStatus?: string } } }>(`https://${board}.bamboohr.com/careers/${id}/detail`);
      const status = d.result?.jobOpening?.jobOpeningStatus;
      return !d.result?.jobOpening ? "expired" : status && !/open/i.test(status) ? "expired" : "active";
    } catch (err) {
      return err instanceof Error && /HTTP 404/.test(err.message) ? "expired" : "unknown";
    }
  },
};
