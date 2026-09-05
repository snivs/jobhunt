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
const ROLE_WORDS = /\b(engineer|engineering|developer|dev|architect|lead|cto|founder|founding|scientist|manager|head of|director|programmer|sre|devops|designer|analyst|product|staff|principal|swe|full[- ]?stack|backend|frontend|back-end|front-end|ml|ai)\b/i;
const MODE_WORDS = /^(remote|onsite|on-site|hybrid|in[- ]office|full[- ]time|part[- ]time|contract|contractor|freelance|intern(ship)?|visa|equity|salary|\$|€|£)/i;

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
  const company = parts[0] && !isUrl(parts[0]) ? parts[0] : (parts.find((p) => !isUrl(p)) ?? null);
  const rest = parts.filter((p) => p !== company);
  const roleCandidates = rest.filter((p) => !isUrl(p) && ROLE_WORDS.test(p) && !MODE_WORDS.test(p) && p.length <= 140);
  // Prefer the shortest role-looking segment: long ones are usually pitch sentences that happen to contain "engineer".
  const title = roleCandidates.sort((a, b) => a.length - b.length)[0] ?? null;
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
