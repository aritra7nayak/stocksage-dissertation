import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Search, Sparkles, Trash2, Users, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { LoadingOrb, ErrorState, ScoreBar } from "../components/shared/ui";
import {
  clearResearchItem, getAnnotators, getResearchItem, getResearchItems, getResearchItemsBatch, getResearchStatus, saveResearchItem,
  searchCompanies, setAnnotator, type AnnotatorUser, type Label, type ResearchItem, type ResearchRow,
  type ResearchStatus, type ReviewFlag, type View,
} from "../api/research";

/* Short versions of research/annotation/GUIDELINES.md, shown next to each choice. */
const HELP: Record<string, Record<string, string>> = {
  sentiment: {
    negative: "Bad for the holder: losses, misses, probes, fraud, defaults, downgrades, war",
    neutral: "Factual or scheduled, mixed news, questions and opinion pieces",
    positive: "Good for the holder: beats, order wins, upgrades, approvals, wanted rate cuts",
  },
  events: {
    regulatory_action: "Orders, bans, probes, penalties or approvals (SEBI, RBI, ED, NCLT, CCI, USFDA, ministry)",
    fraud_default: "Fraud, fund diversion, default, insolvency, auditor exit, governance failure",
    monetary_policy: "RBI rate, liquidity or stance decisions; inflation prints",
    earnings_guidance: "Results, guidance, rating changes, broker targets and buy/sell calls",
    corporate_action: "M&A, demerger, buyback, dividend, fund-raise, capex, plants, layoffs, management, orders",
    macro_geopolitical: "War, pandemic, sanctions, tariffs, GDP, rupee, crude, tax, budget, elections",
    flows: "FII/DII flows, block and bulk deals, promoter pledges and stake sales, index inclusion",
    other: "Commentary, price moves with no stated cause, anything else. Only on its own",
  },
  severity: {
    none: "Not adverse (all good news is none)",
    low: "Minor or routine adverse news",
    medium: "Material but not existential: profit falls 30%, downgrade, probe",
    high: "Fraud, default, SEBI/RBI ban, insolvency, war, market crash",
  },
  scope: {
    market: "The whole Indian market: index moves, RBI policy, war, budget, rupee",
    sector: "One sector or industry, with no single company as the subject",
    company: "Named NSE-listed companies. Link at least one below",
    none: "Not about Indian listed equities, including unlisted or foreign companies",
  },
};
const SENT_COLOR: Record<string, string> = { negative: "#F0526B", neutral: "#8B93A7", positive: "#16C784" };
const PLACEHOLDER = /^(NONE|NA|N\/A|NIL|NULL|NO|-)(\.NS)?$/;
const pretty = (s: string) => s.replace(/_/g, " ");
const blank = (): Label => ({ sentiment: "", events: [], severity: "", scope: "", companies: [], sectors: [], notes: null });
const ist = (ts: string) => new Date(ts).toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
}) + " IST";
const line = { borderColor: "rgb(var(--line) / var(--line-a))" };

function problems(f: Label): string[] {
  const p: string[] = [];
  if (!f.sentiment) p.push("Choose a sentiment");
  if (!f.events.length) p.push("Choose at least one event type (use 'other' if none fits)");
  if (!f.severity) p.push("Choose a severity");
  if (!f.scope) p.push("Choose a scope");
  if (f.sentiment === "positive" && f.severity && f.severity !== "none")
    p.push("Good news has severity 'none': severity measures downside only");
  if (f.scope === "company" && !f.companies.length)
    p.push("Scope 'company' needs at least one NSE company. Unlisted or foreign company? Use scope 'none'");
  return p;
}

/* ── Choice buttons ─────────────────────────────────────────────────────── */
function Choices({ field, options, value, onToggle, multi, pre, flag, onApply }: {
  field: string; options: string[]; value: string[]; onToggle: (v: string) => void; multi?: boolean;
  pre?: string[] | null; flag?: ReviewFlag[]; onApply?: (f: ReviewFlag) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const shownHelp = hover ?? (value.length === 1 ? value[0] : null);
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow">{field}{multi ? " · pick all that apply" : ""}</span>
        {pre && <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-violet"
          style={{ background: "rgb(139 124 246 / 0.14)" }}>
          pre-filled: {pre.map(pretty).join(", ")}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value.includes(o);
          const c = field === "sentiment" ? SENT_COLOR[o] : "#5B8DEF";
          return (
            <button key={o} type="button" onClick={() => onToggle(o)}
              onMouseEnter={() => setHover(o)} onMouseLeave={() => setHover(null)}
              className="rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition hover:scale-[1.03]"
              style={on ? { borderColor: c, background: `${c}26`, color: c } : line}>
              {on && <Check size={12} className="-mt-0.5 mr-1 inline" />}{pretty(o)}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 min-h-[1rem] text-[11px] text-muted">{shownHelp ? HELP[field]?.[shownHelp] : ""}</p>
      {flag?.map((f, i) => (
        <div key={i} className="mt-1 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px]"
          style={{ background: "rgb(242 169 59 / 0.12)", color: "#F2A93B" }}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">
            <b>{f.level === "rule" ? "Breaks a guideline" : "Worth a second look"}:</b> suggest <b>{pretty(f.suggest)}</b>. {f.reason}
          </span>
          {onApply && <button type="button" onClick={() => onApply(f)}
            className="shrink-0 rounded-md border px-2 py-0.5 font-bold" style={{ borderColor: "#F2A93B" }}>Apply</button>}
        </div>
      ))}
    </div>
  );
}

/* ── Company picker over the full NSE list ──────────────────────────────── */
function CompanyPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ symbol: string; name: string }[]>([]);
  const [active, setActive] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits([]); return; }
    timer.current = window.setTimeout(() => {
      searchCompanies(q.trim()).then((r) => { setHits(r); setActive(0); }).catch(() => setHits([]));
    }, 200);
  }, [q]);
  const add = (sym: string) => {
    const s = sym.trim().toUpperCase();
    const full = s.endsWith(".NS") ? s : `${s}.NS`;
    if (/^[A-Z0-9&-]+\.NS$/.test(full) && !value.includes(full)) onChange([...value, full]);
    setQ(""); setHits([]);
  };
  const raw = q.trim().toUpperCase();
  return (
    <div className="mb-5">
      <div className="eyebrow mb-2">companies · NSE-listed companies the headline is about</div>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((c) => (
          <span key={c} className="num inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm font-bold text-brand"
            style={{ background: "rgb(91 141 239 / 0.14)" }}>
            {c.replace(".NS", "")}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== c))}><X size={12} /></button>
          </span>
        ))}
        <div className="relative min-w-[220px] flex-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name or symbol…"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === "Enter") { e.preventDefault(); if (hits[active]) add(hits[active].symbol); }
              if (e.key === "Escape") setHits([]);
            }}
            className="w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none" style={line} />
          {(hits.length > 0 || raw.length >= 2) && (
            <div className="glass absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-xl p-1">
              {hits.map((h, i) => (
                <button key={h.symbol} type="button" onMouseEnter={() => setActive(i)} onClick={() => add(h.symbol)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm"
                  style={{ background: i === active ? "rgb(91 141 239 / 0.14)" : "transparent" }}>
                  <span className="truncate">{h.name}</span>
                  <span className="num shrink-0 text-[11px] font-bold text-muted">{h.symbol.replace(".NS", "")}</span>
                </button>
              ))}
              {hits.length === 0 && PLACEHOLDER.test(raw) && (
                <div className="px-3 py-2 text-sm text-hold">
                  No company? Leave this box empty and set scope to <b>none</b> (or market / sector).
                </div>
              )}
              {hits.length === 0 && /^[A-Z0-9&-]+(\.NS)?$/.test(raw) && !PLACEHOLDER.test(raw) && (
                <button type="button" onClick={() => add(raw)} className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted">
                  Not in the current NSE list (delisted or merged?). Add <b className="num">{raw.replace(".NS", "")}</b> anyway
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-muted">
        Group names are not companies ("Tata group" → none; write "group: Tata" in notes). Link the listed entity
        named: Jio → RELIANCE, Jio Financial → JIOFIN.
      </p>
    </div>
  );
}

/* ── Preloaded headlines ────────────────────────────────────────────────────
   The next PRELOAD headlines in the list are fetched in one request while the
   current one is open, so moving on is instant. A saved or cleared headline is
   dropped from the cache, so it is re-read from the server next time. */
const PRELOAD = 25;
const itemCache = new Map<string, ResearchItem>();
const inFlight = new Set<string>();

function preload(ids: string[]) {
  const want = ids.filter((i) => !itemCache.has(i) && !inFlight.has(i)).slice(0, 30);
  if (!want.length) return;
  want.forEach((i) => inFlight.add(i));
  getResearchItemsBatch(want)
    .then((got) => Object.entries(got).forEach(([i, d]) => itemCache.set(i, d)))
    .catch(() => {})
    .finally(() => want.forEach((i) => inFlight.delete(i)));
}

function formFrom(d: ResearchItem): Label {
  return d.label ?? (d.prelabel
    ? { ...blank(), sentiment: d.prelabel.sentiment, events: d.prelabel.events, severity: d.prelabel.severity, scope: d.prelabel.scope,
        companies: d.prelabel.companies ?? [], sectors: d.prelabel.sectors ?? [] }
    : blank());
}

/* ── One headline ───────────────────────────────────────────────────────── */
function LabelPanel({ id, status, onSaved, onMove }: {
  id: string; status: ResearchStatus; onSaved: (next: string | null) => void; onMove: (id: string) => void;
}) {
  const [data, setData] = useState<ResearchItem | null>(null);
  const [form, setForm] = useState<Label>(blank());
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    let live = true;
    setErr(null);
    const show = (d: ResearchItem) => { setData(d); setForm(formFrom(d)); started.current = Date.now(); };
    const hit = itemCache.get(id);
    if (hit) { show(hit); return; }                      // preloaded: no wait
    setData(null);
    getResearchItem(id).then((d) => { itemCache.set(id, d); if (live) show(d); })
      .catch((e) => live && setErr(e?.response?.data?.detail ?? "Couldn't load this headline"));
    return () => { live = false; };
  }, [id]);

  const issues = useMemo(() => problems(form), [form]);
  const o = status.options;
  const single = (k: "sentiment" | "severity" | "scope") => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggleEvent = (v: string) => setForm((f) => {
    if (v === "other") return { ...f, events: f.events.includes("other") ? [] : ["other"] };
    const without = f.events.filter((e) => e !== "other");
    return { ...f, events: without.includes(v) ? without.filter((e) => e !== v) : [...without, v] };
  });
  const toggleSector = (v: string) => setForm((f) => ({
    ...f, sectors: f.sectors.includes(v) ? f.sectors.filter((s) => s !== v) : [...f.sectors, v],
  }));
  const apply = (flag: ReviewFlag) => setForm((f) => flag.field === "events"
    ? { ...f, events: [flag.suggest] } : { ...f, [flag.field]: flag.suggest });

  const save = useCallback(async () => {
    if (!data || problems(form).length || saving) return;
    setSaving(true); setErr(null);
    try {
      await saveResearchItem(id, { ...form, seconds: (Date.now() - started.current) / 1000, prelabel_shown: !!data.prelabel });
      itemCache.delete(id);
      onSaved(data.next_todo_id);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Save failed");
    } finally { setSaving(false); }
  }, [data, form, id, onSaved, saving]);

  // Keys: 1/2/3 sentiment, Ctrl+Enter save (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); return; }
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const s = { "1": "negative", "2": "neutral", "3": "positive" }[e.key];
      if (s) setForm((f) => ({ ...f, sentiment: s }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!data) return err ? <div className="glass rounded-2xl p-8 text-sell">{err}</div> : <LoadingOrb label="Loading headline…" />;
  const pre = data.prelabel;
  const flagsFor = (f: string) => data.review.filter((r) => r.field === f);

  return (
    <motion.div key={id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl p-6">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span className="num">#{data.index} of {data.total}</span>
        <span className="flex gap-1">
          <button disabled={!data.prev_id} onClick={() => data.prev_id && onMove(data.prev_id)}
            className="rounded-md border p-1 disabled:opacity-30" style={line} title="Previous"><ChevronLeft size={14} /></button>
          <button disabled={!data.next_id} onClick={() => data.next_id && onMove(data.next_id)}
            className="rounded-md border p-1 disabled:opacity-30" style={line} title="Next (skip)"><ChevronRight size={14} /></button>
        </span>
      </div>
      <h2 className="mb-2 font-display text-2xl font-bold leading-snug">{data.item.headline}</h2>
      <div className="mb-5 text-[12px] text-muted">{data.item.source} · {ist(data.item.published_at)}</div>

      {pre && !data.label && (
        <div className="mb-5 flex items-start gap-2 rounded-xl px-4 py-3 text-[13px]"
          style={{ background: "rgb(139 124 246 / 0.12)" }}>
          <Sparkles size={16} className="mt-0.5 shrink-0 text-violet" />
          <span>Pre-filled by the LLM ({pre.model ?? "model"}), all six fields. Read the headline first, then check every field,
            including the company name next to each symbol. Saving marks this row reviewed.</span>
        </div>
      )}
      {data.label && <div className="mb-5 text-[12px] font-bold text-buy"><Check size={13} className="-mt-0.5 mr-1 inline" />Saved. Editing updates your label.</div>}

      <Choices field="sentiment" options={o.sentiment} value={form.sentiment ? [form.sentiment] : []} onToggle={single("sentiment")}
        pre={pre && data.label ? [pre.sentiment] : null} flag={flagsFor("sentiment")} onApply={apply} />
      <Choices field="events" multi options={o.events} value={form.events} onToggle={toggleEvent}
        pre={pre && data.label ? pre.events : null} flag={flagsFor("events")} onApply={apply} />
      <Choices field="severity" options={o.severity} value={form.severity ? [form.severity] : []} onToggle={single("severity")}
        pre={pre && data.label ? [pre.severity] : null} flag={flagsFor("severity")} onApply={apply} />
      <Choices field="scope" options={o.scope} value={form.scope ? [form.scope] : []} onToggle={single("scope")}
        pre={pre && data.label ? [pre.scope] : null} flag={flagsFor("scope")} onApply={apply} />
      <CompanyPicker value={form.companies} onChange={(companies) => setForm((f) => ({ ...f, companies }))} />
      <Choices field="sectors" multi options={o.sectors} value={form.sectors} onToggle={toggleSector} />
      <div className="mb-5">
        <div className="eyebrow mb-2">notes · optional</div>
        <textarea value={form.notes ?? ""} rows={2} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value || null }))}
          placeholder="Anything unusual, e.g. group: Tata · unsure: mixed news"
          className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none" style={line} />
      </div>

      {issues.length > 0 && <ul className="mb-3 list-disc pl-5 text-[12px] text-hold">{issues.map((p) => <li key={p}>{p}</li>)}</ul>}
      {err && <p className="mb-3 text-sm text-sell">{err}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={issues.length > 0 || saving}
          className="rounded-xl px-5 py-2.5 text-sm font-bold text-white transition hover:scale-105 disabled:opacity-40"
          style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
          {saving ? "Saving…" : data.label ? "Update & next" : "Save & next"}
        </button>
        {data.label && (
          <button onClick={async () => { await clearResearchItem(id); itemCache.delete(id); onSaved(id); }}
            className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-sm text-muted" style={line}>
            <Trash2 size={14} /> Clear my label
          </button>
        )}
        <span className="text-[11px] text-muted">Keys: 1 / 2 / 3 sentiment · Ctrl+Enter save</span>
      </div>
    </motion.div>
  );
}

/* ── Admin: assign annotators ───────────────────────────────────────────── */
function AnnotatorsPanel() {
  const [data, setData] = useState<{ users: AnnotatorUser[]; progress: Record<"A" | "B", { done: number; total: number }> } | null>(null);
  const load = () => getAnnotators().then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, []);
  if (!data) return null;
  return (
    <div className="glass mt-8 rounded-2xl p-5">
      <div className="mb-3 flex items-center gap-2"><Users size={16} /><span className="font-display font-bold">Annotators</span></div>
      <p className="mb-4 text-[12px] text-muted">
        A labels all headlines (pre-labels shown where allowed). B labels only the double-annotated subset, from blank,
        and never sees A's labels or any pre-label.
      </p>
      <div className="mb-4 flex gap-6 text-sm">
        {(["A", "B"] as const).map((r) => (
          <span key={r}>Annotator {r}: <b className="num">{data.progress[r].done}</b> / {data.progress[r].total}</span>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {data.users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3 text-sm">
            <span>{u.display_name || u.username} <span className="text-muted">({u.username})</span></span>
            <select value={u.role ?? ""} onChange={async (e) => { await setAnnotator(u.id, (e.target.value || null) as any); load(); }}
              className="rounded-lg border bg-transparent px-2 py-1 text-sm" style={line}>
              <option value="">not an annotator</option>
              <option value="A">Annotator A (full sample)</option>
              <option value="B">Annotator B (double subset)</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */
const VIEWS: { v: View; label: string; onlyA?: boolean }[] = [
  { v: "todo", label: "To do" }, { v: "prefilled", label: "Pre-filled" },
  { v: "flagged", label: "Flagged", onlyA: true }, { v: "done", label: "Done" }, { v: "all", label: "All" },
];

export default function ResearchPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("todo");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ResearchRow[]>([]);
  const [total, setTotal] = useState(0);
  const current = params.get("id");
  const select = useCallback((id: string | null) => setParams(id ? { id } : {}, { replace: true }), [setParams]);

  const loadStatus = useCallback(() => getResearchStatus().then(setStatus)
    .catch((e) => setError(e?.response?.data?.detail ?? "Couldn't load the Research tab. Is the backend running?")), []);
  const loadRows = useCallback(() => getResearchItems(view, q, 0, 200)
    .then((r) => { setRows(r.items); setTotal(r.total); }).catch(() => {}), [view, q]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { const t = window.setTimeout(loadRows, 200); return () => window.clearTimeout(t); }, [loadRows]);
  useEffect(() => { if (!current && rows.length && status) select(rows[0].id); }, [current, rows, status, select]);
  // Preload the open headline's neighbours: the next PRELOAD rows of the current list.
  useEffect(() => {
    if (!rows.length) return;
    const at = Math.max(0, rows.findIndex((r) => r.id === current));
    preload(rows.slice(at, at + PRELOAD + 1).map((r) => r.id));
  }, [current, rows]);

  if (error) return <ErrorState message={error} onRetry={() => { setError(null); loadStatus(); }} />;
  if (!status) return <LoadingOrb label="Loading corpus…" />;
  const pct = status.total ? status.done / status.total : 0;
  const left = status.total - status.done;
  const eta = status.avg_seconds ? Math.round((left * status.avg_seconds) / 3600) : null;

  return (
    <div className="mx-auto max-w-7xl">
      <div className="eyebrow mb-2">Dissertation · Module A · labelling</div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-4xl font-extrabold tracking-tight">Research</h1>
        <span className="glass rounded-full px-4 py-1.5 text-sm font-bold">
          Annotator {status.role} · {status.role === "A" ? "full sample" : "double-annotated subset (A's labels hidden)"}
        </span>
      </div>

      <div className="glass mb-6 grid gap-4 rounded-2xl p-5 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <div className="mb-2 flex justify-between text-sm"><span>Labelled</span>
            <span className="num font-bold">{status.done} / {status.total}</span></div>
          <ScoreBar value={pct} color="#16C784" />
        </div>
        <div><div className="eyebrow">Today</div><div className="num text-xl font-bold">{status.today}</div></div>
        <div><div className="eyebrow">Avg per headline</div>
          <div className="num text-xl font-bold">{status.avg_seconds ? `${Math.round(status.avg_seconds)} s` : "—"}</div>
          {eta !== null && <div className="text-[11px] text-muted">≈ {eta} h left</div>}</div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {VIEWS.filter((x) => !x.onlyA || status.role === "A").map((x) => (
              <button key={x.v} onClick={() => setView(x.v)}
                className="rounded-lg px-3 py-1.5 text-[13px] font-medium transition"
                style={view === x.v ? { background: "rgb(91 141 239 / 0.18)", color: "#5B8DEF" } : { color: "rgb(var(--muted))" }}>
                {x.label}{x.v === "prefilled" ? ` ${status.prefilled_todo}` : x.v === "flagged" ? ` ${status.flagged_todo}` : ""}
              </button>
            ))}
          </div>
          <div className="glass flex items-center gap-2 rounded-xl px-3 py-2">
            <Search size={14} className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search headlines…"
              className="w-full bg-transparent text-sm outline-none" />
          </div>
          <div className="text-[11px] text-muted">{total} headlines{total > rows.length ? ` · showing ${rows.length}` : ""}</div>
          <div className="glass max-h-[70vh] overflow-auto rounded-2xl p-1.5">
            {rows.length === 0 && <div className="p-6 text-center text-sm text-muted">Nothing here.</div>}
            {rows.map((r) => (
              <button key={r.id} onClick={() => select(r.id)}
                className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition"
                style={{ background: r.id === current ? "rgb(91 141 239 / 0.14)" : "transparent" }}>
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: r.done ? SENT_COLOR[r.sentiment ?? "neutral"] : "rgb(var(--muted) / 0.35)" }} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2">{r.headline}</span>
                  <span className="mt-0.5 flex gap-1.5 text-[10px] text-muted">
                    {r.prefilled && <span className="text-violet">pre-filled</span>}
                    {r.flagged && <span className="text-hold">flagged</span>}
                    {r.done && <span className="text-buy">done</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0">
          {current ? (
            <LabelPanel id={current} status={status}
              onMove={(id) => select(id)}
              onSaved={(next) => { loadStatus(); loadRows(); select(next); }} />
          ) : (
            <div className="glass rounded-2xl p-10 text-center text-muted">
              {status.done === status.total ? "All headlines labelled. Thank you!" : "Pick a headline on the left."}
            </div>
          )}
          <details className="glass mt-6 rounded-2xl p-5 text-sm">
            <summary className="cursor-pointer font-bold">How to label (short guide)</summary>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted">
              <li>Label only what the headline says. Don't open the article or use what happened later.</li>
              <li>Sentiment is from the holder's view, not the verb: "Short-sellers lose as Adani stocks rally" is positive.</li>
              <li>Negation flips: "RBI does not hike rates" is positive. Mixed news is neutral unless one side dominates.</li>
              <li>A price move with a stated cause takes the cause's event type; with no cause it is "other".</li>
              <li>Severity is about downside only: good news is always "none".</li>
              <li>One company's fraud is company scope, however large the company.</li>
              <li>When unsure, take the cautious value: neutral, none, other.</li>
              <li>Full rules: research/annotation/GUIDELINES.md.</li>
            </ul>
          </details>
        </div>
      </div>

      {user?.is_admin && <AnnotatorsPanel />}
    </div>
  );
}
