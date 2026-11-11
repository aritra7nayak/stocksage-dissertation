import { useState } from "react";
import { motion } from "framer-motion";
import { LogIn, UserPlus, TrendingUp } from "lucide-react";
import { authLogin, authRegister } from "../api/client";
import { useAuth } from "../lib/auth";

export default function LoginPage() {
  const setAuth = useAuth((s) => s.setAuth);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username || !password) { setErr("Enter a username and password."); return; }
    setBusy(true); setErr(null);
    try {
      const r = mode === "login"
        ? await authLogin(username, password)
        : await authRegister(username, password, displayName || undefined);
      setAuth(r.token, r.user);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || (mode === "login" ? "Sign-in failed." : "Registration failed."));
    } finally { setBusy(false); }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}
        className="glass glow-brand w-full max-w-sm rounded-3xl p-8"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl"
            style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
            <TrendingUp size={20} className="text-white" />
          </div>
          <div>
            <div className="font-display text-xl font-extrabold tracking-tight">StockSage</div>
            <div className="eyebrow">India · sign in to your portfolio</div>
          </div>
        </div>

        {/* mode tabs */}
        <div className="mb-5 flex rounded-xl p-1" style={{ background: "rgb(var(--muted) / 0.1)" }}>
          {(["login", "register"] as const).map((m) => (
            <button key={m} onClick={() => { setMode(m); setErr(null); }}
              className="relative flex-1 rounded-lg py-2 text-sm font-medium transition"
              style={{ color: mode === m ? "rgb(var(--ink))" : "rgb(var(--muted))" }}>
              {mode === m && <motion.div layoutId="authTab" className="glass absolute inset-0 rounded-lg" />}
              <span className="relative z-10">{m === "login" ? "Sign in" : "Create account"}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {mode === "register" && (
            <Field label="Display name (optional)" value={displayName} onChange={setDisplayName} />
          )}
          <Field label="Username" value={username} onChange={setUsername} autoFocus />
          <Field label="Password" value={password} onChange={setPassword} type="password"
            onEnter={submit} />
          {err && <p className="text-sm text-sell">{err}</p>}
          <button onClick={submit} disabled={busy}
            className="mt-1 flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white transition hover:scale-[1.02] disabled:opacity-60"
            style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
            {mode === "login" ? <LogIn size={16} /> : <UserPlus size={16} />}
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          {mode === "register" && (
            <p className="text-center text-[11px] leading-relaxed text-muted">
              The first account created becomes the admin.
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", autoFocus = false, onEnter }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; autoFocus?: boolean; onEnter?: () => void;
}) {
  return (
    <label className="block">
      <span className="eyebrow mb-1 block">{label}</span>
      <input type={type} value={value} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        className="w-full rounded-xl px-3.5 py-2.5 text-sm outline-none transition focus:scale-[1.01]"
        style={{ background: "rgb(var(--muted) / 0.1)", border: "1px solid rgb(var(--line) / var(--line-a))", color: "rgb(var(--ink))" }} />
    </label>
  );
}
