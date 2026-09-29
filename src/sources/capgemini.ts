import type { RawJob, WorkMode } from "../core/normalize.js";
import { htmlToText } from "../core/normalize.js";
import { matchesTerms, type JobSource } from "./types.js";

/**
 * Capgemini's global careers search (https://www.capgemini.com/careers/join-capgemini/job-search/).
 *
 * The search page is a WordPress plugin that reads a public JSON API, cg-jobstream-api, the same
 * one this adapter calls: /api/job-search?country_code=<site>&page=<n>&size=<n>&search=<text>.
 * No key, no login. Each result carries the full HTML description and the SuccessFactors apply
 * link (careers.capgemini.com/job/...). Added 2026-09-29 at the candidate's request.
 *
 * Boards are site country codes as the API returns them ("es-mx" for Mexico, 370 postings that day).
 */

const API = "https://cg-jobstream-api.azurewebsites.net/api/job-search";
const PAGE_SIZE = 100;

interface CgJob {
  id: string;
  ref?: string | null;
  title: string;
  brand?: string | null;
  location?: string | null;
  country_code?: string | null;
  contract_type?: string | null;
  experience_level?: string | null;
  professional_communities?: string | null;
  sbu?: string | null;
  description?: string | null;
  apply_job_url?: string | null;
  indexed_at?: string | null;
  deleted_at?: string | null;
  status?: string | null;
}

interface CgPage {
  total?: number;
  data?: CgJob[];
}

const COUNTRIES: Record<string, string> = { mx: "Mexico", br: "Brazil", ar: "Argentina", co: "Colombia", cl: "Chile", gt: "Guatemala", us: "United States", ca: "Canada" };

function countryOf(code: string | null | undefined): string | null {
  const cc = (code ?? "").split("-").find((p) => p.length === 2 && p in COUNTRIES);
  return cc ? COUNTRIES[cc]! : null;
}

/** The Mexican postings state the arrangement in the body ("Modalidad de trabajo: Hibrido"). */
export function capgeminiWorkMode(text: string): WorkMode | null {
  const m = /modalidad(?: de trabajo)?\s*:\s*(h[ií]brid|presencial|remot)/i.exec(text);
  if (!m) return null;
  const v = m[1]!.toLowerCase();
  return v.startsWith("h") ? "hybrid" : v.startsWith("p") ? "onsite" : "remote";
}

/** Drops tracking parameters from the apply link; the path alone identifies the posting. */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

export const capgemini: JobSource = {
  key: "capgemini",
  async fetch(ctx): Promise<RawJob[]> {
    const out: RawJob[] = [];
    const seen = new Set<string>();
    for (const site of ctx.config.boards) {
      for (let page = 1; out.length < ctx.limit; page++) {
        const res = await ctx.http.getJson<CgPage>(`${API}?country_code=${encodeURIComponent(site)}&page=${page}&size=${PAGE_SIZE}`);
        const items = res.data ?? [];
        for (const j of items) {
          if (out.length >= ctx.limit) break;
          if (j.deleted_at || (j.status && j.status !== "1")) continue;
          // The same requisition is indexed once per language (…-en_GB, …-en_US); keep the first.
          const ref = (j.ref ?? j.id).split("-")[0]!;
          if (seen.has(ref)) continue;
          if (!matchesTerms(ctx.terms, j.title, j.professional_communities ?? "")) continue;
          seen.add(ref);
          const description = j.description ? htmlToText(j.description) : null;
          const country = countryOf(j.country_code ?? site);
          out.push({
            sourceKey: "capgemini",
            externalId: `${site}:${ref}`,
            url: j.apply_job_url ? cleanUrl(j.apply_job_url) : `https://www.capgemini.com/careers/join-capgemini/job-search/?search=${ref}`,
            title: j.title,
            companyName: j.brand || "Capgemini",
            location: [j.location, country].filter(Boolean).join(", ") || null,
            country,
            workMode: description ? capgeminiWorkMode(description) : null,
            description,
            postedAt: j.indexed_at ?? null,
            rawMetadata: {
              site,
              id: j.id,
              contract_type: j.contract_type ?? null,
              experience_level: j.experience_level ?? null,
              professional_community: j.professional_communities ?? null,
              business_unit: j.sbu ?? null,
            },
          });
        }
        if (items.length < PAGE_SIZE || page * PAGE_SIZE >= (res.total ?? 0)) break;
      }
    }
    return out;
  },
  async verify(ctx, job) {
    const [site, ref] = (job.external_id ?? "").split(":");
    if (!site || !ref) return "unknown";
    try {
      const res = await ctx.http.getJson<CgPage>(`${API}?country_code=${encodeURIComponent(site)}&page=1&size=10&search=${encodeURIComponent(ref)}`);
      return (res.data ?? []).some((j) => (j.ref ?? j.id).startsWith(`${ref}-`) && !j.deleted_at) ? "active" : "expired";
    } catch {
      return "unknown";
    }
  },
};
