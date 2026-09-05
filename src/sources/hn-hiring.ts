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
export function parseHiringComment(text: string): { company: string | null; title: string | null; location: string | null; remote: boolean; salaryText: string | null } {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const parts = firstLine.split("|").map((p) => p.trim()).filter(Boolean);
  const remote = /\bremote\b/i.test(firstLine);
  const salary = parts.find((p) => /[$€£]\s?\d|\d+\s?k\b/i.test(p)) ?? null;
  const locationIdx = parts.findIndex((p, i) => i > 1 && !/remote|onsite|on-site|hybrid|full[- ]time|part[- ]time|contract|visa|\$/i.test(p));
  return {
    company: parts[0] ?? null,
    title: parts[1] ?? null,
    location: locationIdx >= 0 ? (parts[locationIdx] ?? null) : remote ? "Remote" : null,
    remote,
    salaryText: salary,
  };
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
