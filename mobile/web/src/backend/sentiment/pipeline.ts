/**
 * Sentiment pipeline — app/sentiment/pipeline.py.
 *   refreshNews()       RSS → FinBERT → keyword severity → news_items (idempotent)
 *   guardStatus()       R12 inputs, re-classified fresh from today's rows
 *   sectorNewsScores()  average sentiment per tracked sector today
 */
import { BASE } from "../config";
import { db, log } from "../platform";
import { j, nowIso } from "../schema";
import { pyRound } from "../util/py";
import { todayStartUtcIso } from "../util/time";
import { classifyHeadline, combineWithSentiment, marketGuardFromToday, urlHash } from "./badNews";
import { modelStatus, scoreHeadlines } from "./finbert";
import { fetchAllFeeds } from "./scrapers";

export async function refreshNews() {
  const raw = await fetchAllFeeds();
  if (!raw.length) return { fetched: 0, new: 0, note: "All feeds unreachable — using stored news" };

  const hashes = new Map<string, (typeof raw)[number]>();
  for (const r of raw) hashes.set(await urlHash(r.url, r.headline), r);
  const keys = [...hashes.keys()];
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    for (const row of db.query(`SELECT url_hash FROM news_items WHERE url_hash IN (${chunk.map(() => "?").join(",")})`, chunk)) {
      existing.add(String(row.url_hash));
    }
  }
  const fresh = [...hashes.entries()].filter(([h]) => !existing.has(h));
  if (fresh.length) {
    const sentiments = await scoreHeadlines(fresh.map(([, r]) => r.headline));
    const ts = nowIso();
    db.batch(fresh.map(([h, r], i) => {
      const s = sentiments[i];
      const c = combineWithSentiment(classifyHeadline(r.headline), s.sentiment, s.score);
      return {
        sql: `INSERT INTO news_items (headline, url, source, sentiment, sentiment_score, severity, is_bad_news,
                related_sectors, published_at, fetched_at, url_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(url_hash) DO NOTHING`,
        params: [r.headline, r.url, r.source, s.sentiment, s.score, c.severity, c.is_bad ? 1 : 0,
          c.sectors.length ? JSON.stringify(c.sectors) : null, r.published_at, ts, h],
      };
    }));
  }
  const model = modelStatus();
  log("info", `News refresh: ${raw.length} fetched, ${fresh.length} new (FinBERT ${model.loaded ? "on" : "off"})`);
  return { fetched: raw.length, new: fresh.length, finbert: model };
}

export interface GuardStatus {
  severe_count: number; systemic_count: number; market_stopped: boolean; blocked_sectors: string[];
  severe_headlines: string[]; evidence: unknown[]; headlines_today: number; avg_sentiment: number;
  overall: string; rule: string; verdict: string;
}

export function guardStatus(): GuardStatus {
  const rows = db.query(
    "SELECT headline, sentiment, sentiment_score FROM news_items WHERE fetched_at >= ?", [todayStartUtcIso()]);
  const cs = rows.map((r) => combineWithSentiment(classifyHeadline(String(r.headline)),
    String(r.sentiment ?? "NEUTRAL"), Number(r.sentiment_score ?? 0)));
  const guard = marketGuardFromToday(cs, BASE.bad_news_headline_limit);
  const scores = rows.filter((r) => r.sentiment_score != null).map((r) => Number(r.sentiment_score));
  const avg = scores.length ? pyRound(scores.reduce((a, b) => a + b, 0) / scores.length, 3) : 0;
  return {
    ...guard,
    headlines_today: rows.length,
    avg_sentiment: avg,
    overall: avg < -0.15 ? "NEGATIVE" : avg > 0.15 ? "POSITIVE" : "NEUTRAL",
    rule: "R12",
    verdict: guard.market_stopped
      ? `Systemic news event — ALL buying paused (R12). ${guard.systemic_count} market-wide severe headlines.`
      : guard.blocked_sectors.length
        ? `Sectors paused by news: ${guard.blocked_sectors.join(", ")}.`
        : "No news-based blocks today.",
  };
}

export function sectorNewsScores(): Record<string, number> {
  const rows = db.query(
    "SELECT related_sectors, sentiment_score FROM news_items WHERE fetched_at >= ? AND related_sectors IS NOT NULL",
    [todayStartUtcIso()]);
  const acc: Record<string, { s: number; n: number }> = {};
  for (const r of rows) {
    for (const sec of j<string[]>(r.related_sectors, [])) {
      const a = (acc[sec] ??= { s: 0, n: 0 });
      // SQL avg() skips NULLs
      if (r.sentiment_score != null) { a.s += Number(r.sentiment_score); a.n++; }
    }
  }
  const out: Record<string, number> = {};
  for (const [sec, a] of Object.entries(acc)) out[sec] = pyRound(a.n ? a.s / a.n : 0, 3);
  return out;
}
