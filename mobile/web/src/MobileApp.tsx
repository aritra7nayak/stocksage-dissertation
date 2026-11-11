/**
 * Mobile shell around the shared pages: a slim top bar, thumb-reach bottom
 * tabs, a "More" sheet for the rest, live engine progress, pull-to-refresh,
 * and Android back-button handling. Pages themselves are the same components
 * the web app uses (frontend/src/pages).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, Briefcase, ChevronRight, Crosshair, GitCompareArrows, LayoutDashboard, LayoutGrid, Newspaper,
  RefreshCw, Settings as SettingsIcon, Smartphone, Sparkles, Target,
} from "lucide-react";
import { useThemeInit } from "@app/lib/theme";
import { ThemeToggle } from "@app/components/shared/ui";
import ErrorBoundary from "@app/components/shared/ErrorBoundary";
import DashboardPage from "@app/pages/DashboardPage";
import SuggestionsPage from "@app/pages/SuggestionsPage";
import PortfolioPage from "@app/pages/PortfolioPage";
import AnalyzerPage from "@app/pages/AnalyzerPage";
import NewsPage from "@app/pages/NewsPage";
import SettingsPage from "@app/pages/SettingsPage";
import ComparePage from "@app/pages/ComparePage";
import DeepDivePage from "@app/pages/DeepDivePage";
import InsightsPage from "@app/pages/InsightsPage";
import OptionsPage from "@app/pages/OptionsPage";
import DevicePage from "./pages/DevicePage";
import EngineBanner from "./ui/EngineBanner";
import { Toasts } from "./ui/toast";
import { haptic } from "./native/bridge";

const TABS = [
  { to: "/", label: "Home", icon: LayoutDashboard },
  { to: "/suggestions", label: "Ideas", icon: Target },
  { to: "/portfolio", label: "Portfolio", icon: Briefcase },
  { to: "/options", label: "Options", icon: Crosshair },
];

const MORE = [
  { to: "/insights", label: "Insights", desc: "Equity curve, journal, risk, dividends", icon: Sparkles, tint: "#8B7CF6" },
  { to: "/analyzer", label: "Backtests", desc: "Replay the rules over 3M–3Y of history", icon: Activity, tint: "#5B8DEF" },
  { to: "/compare", label: "Compare presets", desc: "Conservative vs medium vs aggressive", icon: GitCompareArrows, tint: "#22C5E0" },
  { to: "/news", label: "News", desc: "Headlines scored by FinBERT on this phone", icon: Newspaper, tint: "#F2A93B" },
  { to: "/settings", label: "Rules & capital", desc: "R1–R15 parameters, allocation", icon: SettingsIcon, tint: "#16C784" },
  { to: "/device", label: "Phone & schedule", desc: "Background runs, notifications, data", icon: Smartphone, tint: "#F0526B" },
];

const TITLES: Record<string, string> = {
  "/": "Today", "/suggestions": "Ideas", "/portfolio": "Portfolio", "/options": "Options desk",
  "/insights": "Insights", "/analyzer": "Backtests", "/compare": "Compare", "/news": "News",
  "/settings": "Rules & capital", "/device": "Phone & schedule",
};

function titleFor(path: string): string {
  if (path.startsWith("/stock/")) return decodeURIComponent(path.slice(7)).replace(".NS", "");
  return TITLES[path] ?? "StockSage";
}

const PULL_TRIGGER = 72;

export default function MobileApp() {
  useThemeInit();
  const loc = useLocation();
  const nav = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pull, setPull] = useState(0);
  const start = useRef<number | null>(null);

  // Android back: close the sheet first, else let the WebView history go back.
  useEffect(() => {
    window.__ssNative = {
      ...(window.__ssNative as any),
      onBack: () => {
        if (moreOpen) { setMoreOpen(false); return true; }
        return false;
      },
    };
  }, [moreOpen]);

  useEffect(() => { window.scrollTo(0, 0); setMoreOpen(false); }, [loc.pathname]);

  // Pull-to-refresh: drag down from the very top remounts the current page.
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    start.current = window.scrollY <= 0 && !moreOpen ? e.touches[0].clientY : null;
  }, [moreOpen]);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (start.current === null) return;
    const d = e.touches[0].clientY - start.current;
    if (d > 0 && window.scrollY <= 0) setPull(Math.min(110, d * 0.5));
    else setPull(0);
  }, []);
  const onTouchEnd = useCallback(() => {
    if (pull >= PULL_TRIGGER) {
      haptic("tap");
      setReloadKey((k) => k + 1);
    }
    start.current = null;
    setPull(0);
  }, [pull]);

  const path = loc.pathname;
  const isTab = TABS.some((t) => t.to === path);
  const moreActive = !isTab && !path.startsWith("/stock/");

  return (
    <div className="mobile-shell" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div className="aurora"><span className="a1" /><span className="a2" /><span className="a3" /></div>

      {/* ── Top bar ── */}
      <header className="bar-glass top-bar fixed inset-x-0 top-0 z-40">
        <div className="flex h-[var(--topbar)] items-center gap-3 px-4">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl glow-brand"
            style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
            <span className="font-display text-sm font-extrabold text-white">S</span>
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={titleFor(path)} className="min-w-0 flex-1"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}>
              <div className="truncate font-display text-[17px] font-bold leading-tight">{titleFor(path)}</div>
              <div className="eyebrow text-[9px] leading-tight">StockSage · paper trading</div>
            </motion.div>
          </AnimatePresence>
          <div className="theme-toggle-sm"><ThemeToggle /></div>
        </div>
        <EngineBanner />
      </header>

      {/* ── Pull indicator ── */}
      <div className="pointer-events-none fixed inset-x-0 z-30 flex justify-center"
        style={{ top: `calc(var(--sat) + var(--topbar) + ${pull * 0.6}px)`, opacity: pull / PULL_TRIGGER }}>
        <div className="bar-glass grid h-9 w-9 place-items-center rounded-full">
          <RefreshCw size={16} style={{ transform: `rotate(${pull * 4}deg)`, color: pull >= PULL_TRIGGER ? "#16C784" : undefined }} />
        </div>
      </div>

      {/* ── Page ── */}
      <main className="app-main" style={{ transform: pull ? `translateY(${pull * 0.35}px)` : undefined }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${path}:${reloadKey}`}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
            <ErrorBoundary resetKey={path}>
              <Routes location={loc}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/suggestions" element={<SuggestionsPage />} />
                <Route path="/portfolio" element={<PortfolioPage />} />
                <Route path="/analyzer" element={<AnalyzerPage />} />
                <Route path="/news" element={<NewsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/compare" element={<ComparePage />} />
                <Route path="/stock/:symbol" element={<DeepDivePage />} />
                <Route path="/insights" element={<InsightsPage />} />
                <Route path="/options" element={<OptionsPage />} />
                <Route path="/device" element={<DevicePage />} />
                <Route path="*" element={<DashboardPage />} />
              </Routes>
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ── Bottom tabs ── */}
      <nav className="bar-glass tab-bar fixed inset-x-0 bottom-0 z-40">
        <div className="grid h-[var(--tabbar)] grid-cols-5">
          {TABS.map(({ to, label, icon: Icon }) => {
            const active = path === to;
            return (
              <button key={to} className="tab-btn" onClick={() => { haptic("tap"); if (!active) nav(to); else window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                {active && <motion.span layoutId="tabPill" className="tab-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                <Icon size={21} strokeWidth={active ? 2.4 : 1.9} className={`relative ${active ? "text-ink" : "text-muted"}`} />
                <span className={`relative text-[10.5px] font-semibold ${active ? "text-ink" : "text-muted"}`}>{label}</span>
              </button>
            );
          })}
          <button className="tab-btn" onClick={() => { haptic("tap"); setMoreOpen(true); }}>
            {moreActive && <motion.span layoutId="tabPill" className="tab-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <LayoutGrid size={21} strokeWidth={moreActive ? 2.4 : 1.9} className={`relative ${moreActive ? "text-ink" : "text-muted"}`} />
            <span className={`relative text-[10.5px] font-semibold ${moreActive ? "text-ink" : "text-muted"}`}>More</span>
          </button>
        </div>
      </nav>

      {/* ── More sheet ── */}
      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.div className="fixed inset-0 z-50 bg-black/45" onClick={() => setMoreOpen(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            <motion.div className="sheet fixed inset-x-0 bottom-0 z-50 rounded-t-[28px] px-4 pt-2.5"
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
              drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_, info) => { if (info.offset.y > 90 || info.velocity.y > 500) setMoreOpen(false); }}>
              <div className="mx-auto mb-3 h-1.5 w-11 rounded-full" style={{ background: "rgb(var(--muted) / 0.35)" }} />
              <div className="eyebrow mb-2 px-1">More</div>
              <div className="flex flex-col gap-1.5 pb-2">
                {MORE.map(({ to, label, desc, icon: Icon, tint }, i) => (
                  <motion.button key={to} onClick={() => { haptic("tap"); nav(to); setMoreOpen(false); }}
                    initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 * i }}
                    className={`flex items-center gap-3.5 rounded-2xl px-3 py-3 text-left active:scale-[0.98] ${path === to ? "sheet-active" : ""}`}>
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${tint}22`, color: tint }}>
                      <Icon size={19} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold">{label}</span>
                      <span className="block truncate text-[12px] text-muted">{desc}</span>
                    </span>
                    <ChevronRight size={17} className="text-muted" />
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <Toasts />
    </div>
  );
}
