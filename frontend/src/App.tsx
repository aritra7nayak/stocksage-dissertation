import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { LayoutDashboard, Target, Briefcase, Activity, Newspaper, Settings as SettingsIcon, GitCompareArrows, Sparkles, Crosshair, FlaskConical } from "lucide-react";
import { useThemeInit } from "./lib/theme";
import { useAuth } from "./lib/auth";
import LoginPage from "./pages/LoginPage";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "./components/shared/ui";
import ParticleField from "./components/shared/ParticleField";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import DashboardPage from "./pages/DashboardPage";
import SuggestionsPage from "./pages/SuggestionsPage";
import PortfolioPage from "./pages/PortfolioPage";
import AnalyzerPage from "./pages/AnalyzerPage";
import NewsPage from "./pages/NewsPage";
import SettingsPage from "./pages/SettingsPage";
import ComparePage from "./pages/ComparePage";
import DeepDivePage from "./pages/DeepDivePage";
import InsightsPage from "./pages/InsightsPage";
import OptionsPage from "./pages/OptionsPage";
import ResearchPage from "./pages/ResearchPage";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/suggestions", label: "Suggestions", icon: Target },
  { to: "/portfolio", label: "Portfolio", icon: Briefcase },
  { to: "/insights", label: "Insights", icon: Sparkles },
  { to: "/options", label: "Options", icon: Crosshair },
  { to: "/analyzer", label: "Analyzer", icon: Activity },
  { to: "/compare", label: "Compare", icon: GitCompareArrows },
  { to: "/news", label: "News", icon: Newspaper },
  { to: "/research", label: "Research", icon: FlaskConical },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function App() {
  useThemeInit();
  const loc = useLocation();
  const { token, user, logout } = useAuth();

  if (!token) {
    return (
      <>
        <div className="aurora"><span className="a1" /><span className="a2" /><span className="a3" /></div>
        <LoginPage />
      </>
    );
  }

  return (
    <>
      <div className="aurora"><span className="a1" /><span className="a2" /><span className="a3" /></div>
      <ParticleField />

      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col px-5 py-7 md:flex">
          <div className="mb-10 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <motion.div className="grid h-9 w-9 place-items-center rounded-xl glow-brand"
                style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}
                initial={{ rotate: -12, scale: 0.8 }} animate={{ rotate: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 200 }}>
                <span className="font-display text-lg font-extrabold text-white">S</span>
              </motion.div>
              <div className="leading-tight">
                <div className="font-display text-base font-bold tracking-tight">StockSage</div>
                <div className="eyebrow">India · v0.8</div>
              </div>
            </div>
          </div>

          <nav className="flex flex-col gap-1.5">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end}>
                {({ isActive }) => (
                  <div className={`group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition ${isActive ? "text-ink" : "text-muted hover:text-ink"}`}>
                    {isActive && (
                      <motion.div layoutId="navActive" className="absolute inset-0 rounded-xl glass glow-brand"
                        transition={{ type: "spring", stiffness: 350, damping: 30 }} />
                    )}
                    <Icon size={18} className="relative z-10" />
                    <span className="relative z-10 font-medium">{label}</span>
                  </div>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto flex flex-col gap-3">
            <div className="glass flex items-center justify-between rounded-xl px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{user?.display_name || user?.username}</div>
                <div className="eyebrow text-[9px]">{user?.is_admin ? "ADMIN" : "MEMBER"}</div>
              </div>
              <button onClick={logout} title="Sign out"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg transition hover:scale-110"
                style={{ background: "rgb(var(--muted) / 0.12)" }}>
                <LogOut size={14} className="text-muted" />
              </button>
            </div>
            <ThemeToggle />
            <div className="rounded-xl border px-3.5 py-3" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
              <div className="eyebrow mb-1">Mode</div>
              <div className="num text-sm font-bold text-buy">PAPER TRADING</div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">Personal research. Not investment advice.</p>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-5 py-6 md:px-10 md:py-9">
          <AnimatePresence mode="wait">
            <motion.div key={loc.pathname}
              initial={{ opacity: 0, y: 14, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
              <ErrorBoundary resetKey={loc.pathname}>
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
                <Route path="/research" element={<ResearchPage />} />
              </Routes>
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}
