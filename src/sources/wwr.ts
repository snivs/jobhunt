import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext } from "./types.js";

/** Minimal RSS item parser (no dependency): returns the text of the named tags per <item>. */
export function parseRssItems(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const body = m[1]!;
    const fields: Record<string, string> = {};
    const tagRe = /<([a-zA-Z0-9_:]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(body))) {
      const name = t[1]!;
      let value = t[2]!.trim();
      const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value);
      if (cdata) value = cdata[1]!;
      if (!(name in fields)) fields[name] = value;
    }
    items.push(fields);
  }
  return items;
}

/** "Company: Job Title" -> { company, title } */
export function splitWwrTitle(raw: string): { company: string | null; title: string } {
  const decoded = raw.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const idx = decoded.indexOf(": ");
  if (idx > 0) return { company: decoded.slice(0, idx).trim(), title: decoded.slice(idx + 2).trim() };
  return { company: null, title: decoded.trim() };
}

/** Official RSS feed: https://weworkremotely.com/remote-jobs.rss (plus per-category feeds). */
export const weWorkRemotely: JobSource = {
  key: "weworkremotely",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const feeds = (ctx.config.options.feeds as string[] | undefined) ?? [ctx.config.base_url ?? "https://weworkremotely.com/remote-jobs.rss"];
    const out: RawJob[] = [];
    const seen = new Set<string>();
    for (const feed of feeds) {
      const res = await ctx.http.request(feed, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
      const xml = await res.text();
      for (const it of parseRssItems(xml)) {
        const link = it.link ?? it.guid;
        if (!link || seen.has(link)) continue;
        seen.add(link);
        const { company, title } = splitWwrTitle(it.title ?? "");
        if (!title) continue;
        if (!matchesTerms(ctx.terms, title, it.category, it.skills)) continue;
        const region = it.region ?? null;
        out.push({
          sourceKey: "weworkremotely",
          externalId: it.guid ?? link,
          url: link,
          title,
          companyName: company,
          location: region ?? "Remote",
          remoteScope: region,
          workMode: "remote",
          description: it.description ?? null,
          postedAt: it.pubDate ?? null,
          employmentType: /full/i.test(it.type ?? "") ? "full_time" : /contract/i.test(it.type ?? "") ? "contract" : null,
          rawMetadata: { category: it.category ?? null, skills: it.skills ?? null, expires_at: it.expires_at ?? null, country: it.country ?? null },
        });
        if (out.length >= ctx.limit) return out;
      }
    }
    return out;
  },
};
