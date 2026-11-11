import { create } from "zustand";
import { useEffect } from "react";

type Mode = "system" | "light" | "dark";

interface ThemeState {
  mode: Mode;
  resolved: "light" | "dark";
  setMode: (m: Mode) => void;
}

function systemPref(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
}

export const useTheme = create<ThemeState>((set, get) => ({
  mode: (localStorage.getItem("ss-theme") as Mode) || "system",
  resolved: "dark",
  setMode: (mode) => {
    localStorage.setItem("ss-theme", mode);
    const resolved = mode === "system" ? systemPref() : mode;
    apply(resolved);
    set({ mode, resolved });
  },
}));

// Hook used once at app root to wire system changes + initial apply
export function useThemeInit() {
  const { mode, setMode } = useTheme();
  useEffect(() => {
    setMode(mode); // apply initial
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (useTheme.getState().mode === "system") setMode("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
