import { htmlToText } from "../core/normalize.js";
import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext } from "./types.js";

interface AlgoliaHit {
  objectID: string;
  title: string;
  created_at: string;
}

interface HnItem {
  id: number;
  author: string | null;
  created_at: string;
  text: string | null;
  children?: HnItem[];
}

/**
 * Parses the conventional first line of a "Who is hiring" comment:
 * "Company | Role | Location | REMOTE | Full-time | $150k-$200k".
 */
// Plurals matter: HN posters write "Tech leads" and "Platform engineers" far more often than the
// singular, and without the optional s those segments never register as roles at all.
const ROLE_WORDS = /\b(engineer|engineering|developer|dev|architect|lead|cto|founder|founding|scientist|manager|head of|director|programmer|sre|devops|designer|analyst|product|staff|principal|swe|full[- ]?stack|backend|frontend|back-end|front-end|ml|ai)s?\b/i;
const MODE_WORDS = /^(remote|onsite|on-site|hybrid|in[- ]office|full[- ]time|part[- ]time|contract|contractor|freelance|intern(ship)?|visa|equity|salary|\$|€|£)/i;

/**
 * Past this a segment is prose that happens to contain a role word, not a title. HN posters do
 * legitimately list several roles in one segment, so the cap is generous on purpose.
 */
const MAX_TITLE = 120;

/** Where a pitch starts once the title has ended. */
const PITCH_MARKERS = /\s(?:we’?'?re|we|our|i|i’?'?m|about|founded|apply|looking for|https?:\/\/|@)/i;

/** Titles are full of abbreviations ("Sr. Staff Engineer"); those dots do not end a sentence. */
const ABBREVIATION_DOT = /(?:sr|jr|dr|mr|ms|mrs|st|inc|ltd|co|corp|vs|etc|sen|assoc)\.$/i;

/**
 * Turns a pipe segment into something a person would recognise as a job title, or null.
 *
 * The governing rule is DO NOT TOUCH WHAT IS ALREADY REASONABLE. A first attempt at this cut every
 * segment at its first sentence and destroyed twenty perfectly good titles, "Sr. Engineer" among
 * them, because an abbreviation's dot looks exactly like a full stop. So the rescue only runs on a
 * segment that is too long to be a title in the first place.
 *
 * Two things go wrong in the live corpus:
 *
 * 1. Posters write the role as a regex. Better Stack posted `/^Full-?stack Engineer$/i`, which is a
 *    joke a developer-tools company can afford and a useless title everywhere downstream. Unwrap it
 *    rather than discard it: the job behind it is real.
 * 2. `htmlToText` leaves many comments without a newline where the header ends, so "the first line"
 *    is the whole comment and the final segment carries the role AND the entire pitch. Cutting at
 *    the first sentence or pitch marker recovers the title; the body is still kept as description.
 */
export function cleanTitleSegment(raw: string): { title: string; rescued: boolean } | null {
  let s = collapse(raw);
  let rescued = false;

  // A regex literal is never a usable title, however short: /^Full-?stack Engineer$/i
  const asRegex = s.match(/^\/(.+)\/[gimsuy]*$/);
  if (asRegex?.[1]) {
    s = collapse(
      asRegex[1]
        .replace(/[$^]/g, "")
        .replace(/\\(.)/g, "$1") // unescape a backslash-escaped character
        .replace(/\?/g, "") // "Full-?stack" -> "Full-stack": the optional character itself stays
        .replace(/[()[\]{}|*+]/g, " "),
    );
  }

  // Only prose needs rescuing. A segment that already reads like a title is returned untouched.
  if (s.length > MAX_TITLE) {
    rescued = true;
    s = collapse(cutAtPitch(s));
    // Some segments are just a long list of roles with nowhere to cut. Truncating gives a mediocre
    // title; returning null drops the job entirely. The description carries the real content, so a
    // mediocre title is the cheaper mistake.
    if (s.length > MAX_TITLE) s = collapse(s.slice(0, s.lastIndexOf(" ", MAX_TITLE)));
  }

  if (!s) return null;
  if (!ROLE_WORDS.test(s)) return null;
  return { title: s, rescued };
}

/** Trims an over-long segment back to the part that reads like a title. */
function cutAtPitch(s: string): string {
  let best = s;

  // First sentence, ignoring dots that belong to an abbreviation.
  for (const m of s.matchAll(/[.!?](?=\s|$)/g)) {
    const at = m.index ?? 0;
    if (at < 12) continue; // too early to be the end of a title
    if (ABBREVIATION_DOT.test(s.slice(0, at + 1))) continue;
    best = s.slice(0, at);
    break;
  }

  const pitch = best.search(PITCH_MARKERS);
  if (pitch >= 12) best = best.slice(0, pitch);
  return best;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "");
}

/**
 * Parses the conventional first line of a "Who is hiring" comment. The order of segments varies
 * (Company | Role | Location, Company | Location | Role, Company | URL | Role ...), so each segment
 * is classified rather than taken positionally. Segments are capped so a sentence never becomes a title.
 */
export function parseHiringComment(text: string): { company: string | null; title: string | null; location: string | null; remote: boolean; salaryText: string | null } {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const parts = firstLine
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.length > 140 ? p.slice(0, 140) : p));
  const remote = /\bremote\b/i.test(firstLine);
  const salary = parts.find((p) => /[$€£]\s?\d|\d+\s?k\b/i.test(p)) ?? null;
  const isUrl = (p: string) => /^(https?:\/\/|www\.)/i.test(p) || /^[a-z0-9.-]+\.(com|io|ai|dev|co|org|net|fm|app)(\/|$)/i.test(p);
  // The first segment is the company by convention, even when it is a bare domain ("Matcha.fm");
  // only a full URL (http://..., www....) in first position is skipped.
  const isFullUrl = (p: string) => /^(https?:\/\/|www\.)/i.test(p);
  const company = parts[0] && !isFullUrl(parts[0]) ? parts[0] : (parts.find((p) => !isUrl(p)) ?? null);
  const rest = parts.filter((p) => p !== company);
  const roleCandidates = rest
    .filter((p) => !isUrl(p) && ROLE_WORDS.test(p) && !MODE_WORDS.test(p))
    .map(cleanTitleSegment)
    .filter((p): p is { title: string; rescued: boolean } => p !== null);
  // A segment that already read like a title always beats one trimmed out of prose. Without that
  // rule a rescued fragment can win the "shortest" contest and replace a perfectly good title.
  // Among equals, prefer the shortest: long ones are pitch sentences that happen to say "engineer".
  const byQuality = [...roleCandidates].sort(
    (a, b) => Number(a.rescued) - Number(b.rescued) || a.title.length - b.title.length,
  );
  const title = byQuality[0]?.title ?? null;
  const location =
    rest.find((p) => p !== title && !isUrl(p) && !MODE_WORDS.test(p) && !ROLE_WORDS.test(p) && p.length <= 60 && !/[$€£]\s?\d|\d+\s?k\b/i.test(p)) ??
    (remote ? "Remote" : null);
  return { company, title, location, remote, salaryText: salary };
}

/** Official HN Algolia API (https://hn.algolia.com/api): latest "Ask HN: Who is hiring?" thread. */
export const hnHiring: JobSource = {
  key: "hn_hiring",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const base = ctx.config.base_url ?? "https://hn.algolia.com/api/v1";
    const search = await ctx.http.getJson<{ hits: AlgoliaHit[] }>(`${base}/search_by_date?query=${encodeURIComponent('"who is hiring"')}&tags=story,author_whoishiring&hitsPerPage=5`);
    const thread = search.hits.find((h) => /who is hiring/i.test(h.title));
    if (!thread) return [];
    const item = await ctx.http.getJson<HnItem>(`${base}/items/${thread.objectID}`);
    const out: RawJob[] = [];
    for (const c of item.children ?? []) {
      if (!c.text) continue;
      const text = htmlToText(c.text) ?? "";
      const parsed = parseHiringComment(text);
      if (!parsed.title || !parsed.company) continue;
      if (!matchesTerms(ctx.terms, parsed.title, text.slice(0, 600))) continue;
      out.push({
        sourceKey: "hn_hiring",
        externalId: String(c.id),
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        title: parsed.title,
        companyName: parsed.company,
        location: parsed.location,
        workMode: parsed.remote ? "remote" : null,
        description: text,
        postedAt: c.created_at,
        salary: parsed.salaryText ? { text: parsed.salaryText } : null,
        rawMetadata: { thread_id: thread.objectID, thread_title: thread.title, author: c.author },
      });
      if (out.length >= ctx.limit) break;
    }
    return out;
  },
};
