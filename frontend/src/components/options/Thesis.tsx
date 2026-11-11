import { CircleCheck, CircleX, ShieldAlert, ThumbsUp, OctagonX } from "lucide-react";
import type { OptionsAnalysis } from "../../api/options";
import { BAD, GOOD, Panel } from "./parts";

export function ThesisPanel({ a }: { a: OptionsAnalysis }) {
  const n = a.narrative;
  const sideWord = a.verdict.side === "CE" ? "call (bullish)" : "put (bearish)";
  return (
    <Panel title="The case, in plain words" hint={`Reasons are ranked by how much weight they carry in the score. Shown for the ${sideWord} side.`}>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        <List icon={<ThumbsUp size={14} style={{ color: GOOD }} />} title={`Supports the ${sideWord}`} items={n.supporting}
          empty="Nothing meaningful supports this side." />
        <List icon={<ShieldAlert size={14} style={{ color: "#F2A93B" }} />} title="Against it / risks" items={n.risks}
          empty="No meaningful opposing signals." />
        <List icon={<OctagonX size={14} style={{ color: BAD }} />} title="Exit if (thesis is wrong)" items={n.invalidation} empty="—" />
      </div>
    </Panel>
  );
}

function List({ icon, title, items, empty }: { icon: React.ReactNode; title: string; items: string[]; empty: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-bold">{icon}{title}</div>
      {items.length === 0 ? <p className="text-[12px] text-muted">{empty}</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((t, i) => {
            const [head, ...rest] = t.split(": ");
            return (
              <li key={i} className="text-[12.5px] leading-relaxed">
                {rest.length ? <><b>{head}:</b> <span className="text-muted">{rest.join(": ")}</span></> : <span className="text-muted">{t}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ChecklistPanel({ a }: { a: OptionsAnalysis }) {
  const ok = a.checklist.filter((c) => c.ok).length;
  return (
    <Panel title="Pre-trade checklist" hint="Auto-evaluated from live data. The more items pass, the cleaner the setup. Treat any ✗ as a reason to size smaller or skip."
      right={<span className="num text-sm font-bold" style={{ color: ok >= 7 ? GOOD : ok >= 5 ? "#F2A93B" : BAD }}>{ok}/{a.checklist.length} pass</span>}>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {a.checklist.map((c) => (
          <li key={c.label} className="flex items-start gap-2.5 rounded-xl p-2.5" style={{ background: "rgb(var(--muted) / 0.07)" }}>
            {c.ok ? <CircleCheck size={16} className="mt-0.5 shrink-0" style={{ color: GOOD }} aria-label="pass" />
              : <CircleX size={16} className="mt-0.5 shrink-0" style={{ color: BAD }} aria-label="fail" />}
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium">{c.label}</div>
              <div className="num text-[11px] text-muted">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
