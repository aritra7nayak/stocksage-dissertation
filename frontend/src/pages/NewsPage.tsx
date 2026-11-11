import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getNews, type NewsItem } from "../api/client";
import { LoadingOrb, ErrorState } from "../components/shared/ui";

const sentColor = (s: string) =>
  ({ POSITIVE: "#16C784", NEGATIVE: "#F0526B", NEUTRAL: "rgb(var(--muted))" } as Record<string, string>)[s] || "rgb(var(--muted))";

export default function NewsPage() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await getNews(40)); }
    catch { setError("Couldn't load news. Is the backend running on port 8000?"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingOrb label="Loading market news…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="eyebrow mb-2">FinBERT Sentiment · GPU-scored</div>
      <h1 className="mb-8 font-display text-4xl font-extrabold tracking-tight">Market News</h1>
      {items.length === 0 ? (
        <div className="glass rounded-2xl p-10 text-center text-muted">
          No news stored yet. Run the engine (Dashboard → Refresh) to fetch today's headlines.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((n, i) => (
            <motion.a key={i} href={n.url} target="_blank" rel="noreferrer" className="glass block rounded-xl p-4 transition hover:scale-[1.01]"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.4) }}
              style={n.is_bad_news ? { borderColor: "rgb(240 82 107 / 0.3)" } : {}}>
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm leading-relaxed">{n.headline}</p>
                <span className="num shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold"
                  style={{ color: sentColor(n.sentiment), background: "rgb(var(--muted) / 0.12)" }}>
                  {(n.sentiment_score ?? 0) >= 0 ? "+" : ""}{(n.sentiment_score ?? 0).toFixed(2)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                <span>{n.source}</span>
                {n.severity >= 6 && <span className="rounded px-1.5 py-0.5 font-bold text-sell" style={{ background: "rgb(240 82 107 / 0.15)" }}>SEVERE</span>}
                {n.sectors.map((s) => <span key={s} className="rounded px-1.5 py-0.5" style={{ background: "rgb(var(--muted) / 0.1)" }}>{s}</span>)}
              </div>
            </motion.a>
          ))}
        </div>
      )}
    </div>
  );
}
