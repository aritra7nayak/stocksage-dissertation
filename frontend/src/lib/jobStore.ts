import { create } from "zustand";

/** Remembers running backtest jobs across page navigation (module state)
    and browser refresh (localStorage). Finished results are kept in memory
    so returning to a page shows them instantly without refetching. */

export interface ActiveJob { jobId: string; preset?: string; }

interface JobState {
  activeMulti: ActiveJob | null;
  activeCompare: ActiveJob | null;
  lastMultiResult: any | null;    // full MultiStatus payload of last DONE run
  lastCompareResult: any | null;  // full CompareStatus payload of last DONE run
  setActiveMulti: (j: ActiveJob | null) => void;
  setActiveCompare: (j: ActiveJob | null) => void;
  setLastMultiResult: (r: any | null) => void;
  setLastCompareResult: (r: any | null) => void;
}

const LS_MULTI = "ss-active-multi";
const LS_COMPARE = "ss-active-compare";

function readLS(key: string): ActiveJob | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ActiveJob) : null;
  } catch { return null; }
}
function writeLS(key: string, v: ActiveJob | null) {
  try {
    if (v) localStorage.setItem(key, JSON.stringify(v));
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
}

export const useJobs = create<JobState>((set) => ({
  activeMulti: readLS(LS_MULTI),
  activeCompare: readLS(LS_COMPARE),
  lastMultiResult: null,
  lastCompareResult: null,
  setActiveMulti: (j) => { writeLS(LS_MULTI, j); set({ activeMulti: j }); },
  setActiveCompare: (j) => { writeLS(LS_COMPARE, j); set({ activeCompare: j }); },
  setLastMultiResult: (r) => set({ lastMultiResult: r }),
  setLastCompareResult: (r) => set({ lastCompareResult: r }),
}));
