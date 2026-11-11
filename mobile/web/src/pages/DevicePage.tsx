/**
 * Phone & schedule — the mobile replacement for the server's scheduler and
 * health endpoints: which background runs are on, whether Android will let
 * them fire, what ran recently, and the on-device data.
 */
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlarmClock, BatteryCharging, Bell, BrainCircuit, CheckCircle2, Database, Play, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { api } from "@app/api/client";
import { envelope, haptic, native } from "../native/bridge";
import { toast } from "../ui/toast";

interface Job { type: string; label: string; time: string; enabled: boolean }
interface Sched {
  jobs: Job[]; next: { type: string; at_ms: number } | null;
  exact_alarm_allowed: boolean; notifications_allowed: boolean; battery_unrestricted: boolean;
}
interface AppInfo { version: string; build: number; device: string; android: string }

const fmtWhen = (ms: number) => new Date(ms).toLocaleString("en-IN", {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
});
const fmtTs = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
}) : "—");

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`glass rounded-2xl p-4 ${className}`}>{children}</div>;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => { haptic("tap"); onChange(!on); }} aria-pressed={on}
      className="relative h-7 w-12 shrink-0 rounded-full transition-colors"
      style={{ background: on ? "#16C784" : "rgb(var(--muted) / 0.3)" }}>
      <motion.span className="absolute top-0.5 h-6 w-6 rounded-full bg-white shadow"
        animate={{ left: on ? 22 : 2 }} transition={{ type: "spring", stiffness: 600, damping: 35 }} />
    </button>
  );
}

function Permission({ ok, label, hint, onFix }: { ok: boolean; label: string; hint: string; onFix: () => void }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      {ok ? <CheckCircle2 size={18} className="shrink-0 text-buy" /> : <ShieldAlert size={18} className="shrink-0 text-hold" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-[12px] leading-snug text-muted">{hint}</div>
      </div>
      {!ok && <button onClick={onFix} className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: "#5B8DEF" }}>Fix</button>}
    </div>
  );
}

export default function DevicePage() {
  const [sched, setSched] = useState<Sched | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  const load = useCallback(async () => {
    if (native) {
      try { setSched(envelope<Sched>(native.scheduleInfo())); } catch { /* ignore */ }
      try { setInfo(envelope<AppInfo>(native.appInfo())); } catch { /* ignore */ }
    }
    try { setStatus((await api.get("/api/mobile/status")).data); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void load();
    // Permissions are granted in system screens; refresh when we come back.
    const onVis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  const setJob = (type: string, enabled: boolean) => {
    if (!native || !sched) return;
    const jobs = sched.jobs.map((j) => (j.type === type ? { ...j, enabled } : j));
    try { setSched(envelope<Sched>(native.setSchedule(JSON.stringify({ enabled: Object.fromEntries(jobs.map((j) => [j.type, j.enabled])) })))); }
    catch (e) { toast((e as Error).message, "error"); }
  };

  const runNow = (type: string) => {
    native?.runJobNow(type);
    haptic("success");
    toast("Started in the background — you'll get a notification when it's done", "success");
  };

  const reset = async (scope: "paper" | "everything") => {
    const msg = scope === "paper"
      ? "Reset the paper portfolio? Holdings, paper trades, suggestions and the equity curve are cleared."
      : "Erase ALL app data on this phone — trades, imports, backtests, news? Rules and settings are kept.";
    if (!window.confirm(msg)) return;
    try {
      const r = (await api.post("/api/mobile/reset", { scope })).data;
      toast(r.status, "success");
      void load();
    } catch { toast("Reset failed", "error"); }
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <Card>
        <div className="mb-1 flex items-center gap-2"><AlarmClock size={17} className="text-brand" /><span className="font-display font-bold">Background runs</span></div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
          Like the server's scheduler, but on this phone: Android wakes StockSage at these IST times on weekdays,
          runs the engine with fresh prices and news, and notifies you. The app doesn't need to be open.
        </p>
        {sched?.jobs.map((j) => (
          <div key={j.type} className="flex items-center gap-3 border-t py-3" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
            <div className="num w-12 shrink-0 text-[15px] font-bold">{j.time}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{j.label}</div>
              <button onClick={() => runNow(j.type)} className="mt-0.5 flex items-center gap-1 text-[12px] font-semibold text-brand">
                <Play size={11} /> Run now
              </button>
            </div>
            <Toggle on={j.enabled} onChange={(v) => setJob(j.type, v)} />
          </div>
        ))}
        {sched && (
          <div className="mt-1 rounded-xl px-3 py-2.5 text-[12.5px]" style={{ background: "rgb(var(--muted) / 0.08)" }}>
            {sched.next ? <>Next: <b>{sched.jobs.find((j) => j.type === sched.next!.type)?.label}</b> · {fmtWhen(sched.next.at_ms)}</> : "All background runs are off."}
          </div>
        )}
        {!native && <p className="text-sm text-muted">Scheduling is only available in the Android app.</p>}
      </Card>

      {sched && (
        <Card>
          <div className="mb-1 flex items-center gap-2"><Bell size={17} className="text-hold" /><span className="font-display font-bold">Let Android run it on time</span></div>
          <Permission ok={sched.notifications_allowed} label="Notifications" onFix={() => native?.openSettings("notifications")}
            hint="So the morning brief and stop-loss alerts can reach you." />
          <Permission ok={sched.exact_alarm_allowed} label="Exact alarms" onFix={() => native?.openSettings("exact_alarm")}
            hint="Lets runs start at 08:30 sharp instead of whenever Android batches them." />
          <Permission ok={sched.battery_unrestricted} label="Unrestricted battery" onFix={() => native?.openSettings("battery")}
            hint="Some phones (Xiaomi, Oppo, Vivo, OnePlus) kill background work unless this is allowed." />
        </Card>
      )}

      {status && (
        <Card>
          <div className="mb-2 flex items-center gap-2"><BatteryCharging size={17} className="text-buy" /><span className="font-display font-bold">Recent runs</span></div>
          {status.runs.length === 0 && <p className="text-[12.5px] text-muted">Nothing yet — the first scheduled run will appear here.</p>}
          {status.runs.map((r: any, i: number) => (
            <div key={i} className="flex items-start gap-2.5 border-t py-2.5 first:border-t-0" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
              {r.status === "DONE" ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-buy" />
                : r.status === "FAILED" ? <XCircle size={15} className="mt-0.5 shrink-0 text-sell" />
                  : <AlarmClock size={15} className="mt-0.5 shrink-0 text-hold" />}
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2 text-[13px] font-semibold">
                  <span className="truncate">{r.summary?.title ?? r.run_type}</span>
                  <span className="num shrink-0 text-[11px] font-normal text-muted">{fmtTs(r.started_at)}</span>
                </div>
                {r.summary?.body && <div className="text-[12px] leading-snug text-muted">{r.summary.body}</div>}
              </div>
            </div>
          ))}
        </Card>
      )}

      {status && (
        <Card>
          <div className="mb-2 flex items-center gap-2"><BrainCircuit size={17} className="text-violet" /><span className="font-display font-bold">On this phone</span></div>
          <div className="text-[12.5px] leading-relaxed text-muted">
            FinBERT: <b className="text-ink">{status.finbert.loaded ? "loaded" : status.finbert.load_failed ? "unavailable — keyword-only mode" : "loads on first news refresh"}</b>
            {" · "}{status.finbert.model}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {Object.entries(status.counts as Record<string, number>).map(([k, v]) => (
              <div key={k} className="rounded-xl px-3 py-2" style={{ background: "rgb(var(--muted) / 0.08)" }}>
                <div className="num text-base font-bold">{v.toLocaleString("en-IN")}</div>
                <div className="eyebrow text-[8.5px]">{k.replace(/_/g, " ")}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            <Database size={12} className="mr-1 inline" />
            Everything lives in a SQLite database inside the app. The only network traffic is market data
            (Yahoo Finance, NSE) and news feeds — no laptop, no server, no account.
          </p>
        </Card>
      )}

      <Card>
        <div className="mb-2 flex items-center gap-2"><Trash2 size={17} className="text-sell" /><span className="font-display font-bold">Data</span></div>
        <div className="flex flex-col gap-2">
          <button onClick={() => reset("paper")} className="rounded-xl border px-4 py-3 text-left text-sm font-semibold active:scale-[0.99]"
            style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>Reset paper portfolio</button>
          <button onClick={() => reset("everything")} className="rounded-xl border px-4 py-3 text-left text-sm font-semibold text-sell active:scale-[0.99]"
            style={{ borderColor: "rgb(240 82 107 / 0.35)" }}>Erase all app data</button>
        </div>
      </Card>

      {info && (
        <p className="pb-2 text-center text-[11px] text-muted">
          StockSage {info.version} ({info.build}) · {info.device} · Android {info.android}<br />
          Personal research tool. Not investment advice.
        </p>
      )}
    </div>
  );
}
