/**
 * RSS scrapers — app/sentiment/scrapers.py. No API keys; each feed is
 * independent so one source going down never breaks the run. A small
 * tolerant parser replaces feedparser (RSS 2.0 items and Atom entries).
 */
import { log, platform } from "../platform";

export const FEEDS: Record<string, string> = {
  "Economic Times Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  "Moneycontrol Top News": "https://www.moneycontrol.com/rss/MCtopnews.xml",
  "Moneycontrol Markets": "https://www.moneycontrol.com/rss/marketreports.xml",
  "Livemint Markets": "https://www.livemint.com/rss/markets",
  "Business Standard Markets": "https://www.business-standard.com/rss/markets-106.rss",
};

const MAX_PER_FEED = 25;

export interface RawNewsItem {
  headline: string;
  url: string;
  source: string;
  published_at: string | null;   // ISO UTC
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return null;
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cdata) v = cdata[1];
  return v.trim();
}

function atomLink(block: string): string | null {
  const m = /<link[^>]*href="([^"]+)"[^>]*\/?>/i.exec(block);
  return m ? m[1] : null;
}

function parseDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s.replace(/\s+[A-Z]{3,4}$/, (z) => (z.trim() === "IST" ? " +0530" : z)));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseFeed(xml: string, source: string): RawNewsItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: RawNewsItem[] = [];
  for (const b of blocks.slice(0, MAX_PER_FEED)) {
    // feedparser also unescapes entities and strips markup from titles
    const title = unescapeHtml((tag(b, "title") ?? "").replace(/<[^>]+>/g, "")).trim();
    const link = unescapeHtml(tag(b, "link") || atomLink(b) || "").trim();
    if (title.length < 15) continue;
    out.push({
      headline: title, url: link, source,
      published_at: parseDate(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date")),
    });
  }
  return out;
}

export async function fetchAllFeeds(): Promise<RawNewsItem[]> {
  const results = await Promise.all(Object.entries(FEEDS).map(async ([source, url]) => {
    try {
      const r = await platform().http({
        url, timeoutMs: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) StockSage/1.0", Accept: "application/rss+xml,application/xml,text/xml,*/*" },
      });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      const items = parseFeed(r.body, source);
      log("info", `${source}: ${items.length} items`);
      return items;
    } catch (e) {
      log("warn", `${source} failed (${(e as Error).message}) — skipped`);
      return [];
    }
  }));
  return results.flat();
}
