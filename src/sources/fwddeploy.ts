import type { RawJob } from "../core/normalize.js";
import { matchesTerms, type JobSource, type SourceContext } from "./types.js";
import { parseRssItems } from "./wwr.js";

/**
 * Splits fwddeploy's title convention: "Role - Company - Location".
 *
 * Roles carry hyphens of their own ("Forward Deployed Engineer - I", "(m/w/d)"), so splitting on
 * every hyphen shreds them. The location is always last and the company second to last, so the
 * segments are taken from the END and everything remaining is the role.
 */
export function splitFwdTitle(raw: string): { title: string; company: string | null; location: string | null } {
  const decoded = raw.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  const parts = decoded.split(" - ").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return { title: decoded, company: null, location: null };
  const location = parts[parts.length - 1]!;
  const company = parts[parts.length - 2]!;
  const title = parts.slice(0, -2).join(" - ");
  return { title: title || decoded, company, location };
}

/**
 * fwddeploy.com - a board dedicated to Forward Deployed Engineer roles, via its official RSS feed.
 * Its robots.txt allows everything and `/jobs.rss` serves real `application/rss+xml`.
 *
 * Why it earns a place despite a bad hit rate: this is the closest title in the market to how the
 * candidate actually works - specifying behaviour, building evaluation harnesses, deploying agents
 * into customer systems - and the role barely exists on general aggregators. The catch, measured
 * rather than assumed: the board is overwhelmingly United States, Europe, India and APAC, with
 * almost nothing open to LATAM. Nearly every posting here will be rejected by `workable_from`, with
 * a readable reason. That is the point of discovering broadly and scoring narrowly: when one of
 * these does open to the Americas, it gets caught the day it appears instead of never.
 */
export const fwddeploy: JobSource = {
  key: "fwddeploy",
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const feed = ctx.config.base_url ?? "https://www.fwddeploy.com/jobs.rss";
    const res = await ctx.http.request(feed, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
    const xml = await res.text();

    const out: RawJob[] = [];
    const seen = new Set<string>();
    for (const it of parseRssItems(xml)) {
      const link = it.link ?? it.guid;
      if (!link || seen.has(link)) continue;
      seen.add(link);

      const { title, company, location } = splitFwdTitle(it.title ?? "");
      if (!title) continue;
      if (!matchesTerms(ctx.terms, title, it.category)) continue;

      out.push({
        sourceKey: "fwddeploy",
        externalId: it.guid ?? link,
        url: link,
        title,
        companyName: company,
        location,
        // The board does not state work mode. Leaving it unknown is honest: the scorer will ask for
        // a manual check rather than assume a forward-deployed role is remote, which it often is not.
        workMode: null,
        remoteScope: location,
        description: it.description ?? null,
        postedAt: it.pubDate ?? null,
        rawMetadata: { board: "fwddeploy", raw_title: it.title ?? null },
      });
      if (out.length >= ctx.limit) return out;
    }
    return out;
  },
};
