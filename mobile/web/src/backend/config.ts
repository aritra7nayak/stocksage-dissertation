/**
 * Settings — the .env defaults of app/config.py, plus the live overlay the
 * Settings page writes to app_settings. Every engine/backtest run reads
 * liveSettings(), so edits apply on the next run with no restart.
 */
import { db } from "./platform";

export interface Settings {
  total_capital: number;
  cash_reserve_pct: number;
  gold_silver_pct: number;
  nifty50_pct: number;
  nifty_next100_pct: number;
  smallcap_pct: number;
  min_stock_purchase: number;
  max_stock_purchase: number;
  min_etf_purchase: number;
  max_etf_purchase: number;
  max_daily_invest_pct: number;
  stop_loss_pct: number;
  deterioration_score: number;
  deterioration_days: number;
  trailing_profit_trigger: number;
  trailing_profit_giveback: number;
  nifty_fall_threshold: number;
  bad_news_headline_limit: number;
  weight_technical: number;
  weight_fundamental: number;
  weight_sentiment: number;
  paper_trading: boolean;
  nifty50_index: string;
  sensex_index: string;
  gold_etf: string;
  silver_etf: string;
  tracked_sectors: readonly string[];
}

export const BASE: Settings = Object.freeze({
  total_capital: 100_000,
  cash_reserve_pct: 0.2,
  gold_silver_pct: 0.2,
  nifty50_pct: 0.3,
  nifty_next100_pct: 0.2,
  smallcap_pct: 0.1,
  min_stock_purchase: 7_000,
  max_stock_purchase: 9_000,
  min_etf_purchase: 5_000,
  max_etf_purchase: 6_000,
  max_daily_invest_pct: 0.2,
  stop_loss_pct: 0.08,
  deterioration_score: 0.35,
  deterioration_days: 3,
  trailing_profit_trigger: 0.15,
  trailing_profit_giveback: 0.05,
  nifty_fall_threshold: -0.1,
  bad_news_headline_limit: 3,
  weight_technical: 0.4,
  weight_fundamental: 0.35,
  weight_sentiment: 0.25,
  paper_trading: true,
  nifty50_index: "^NSEI",
  sensex_index: "^BSESN",
  gold_etf: "GOLDBEES.NS",
  silver_etf: "SILVERBEES.NS",
  tracked_sectors: Object.freeze([
    "IT", "Banking & Finance", "Manufacturing", "Services",
    "Metal", "Oil & Gas", "Energy & Power", "Pharma & Healthcare", "FMCG",
  ]),
});

export type EditableKey = keyof Pick<Settings,
  | "total_capital" | "cash_reserve_pct" | "gold_silver_pct" | "nifty50_pct" | "nifty_next100_pct"
  | "smallcap_pct" | "min_stock_purchase" | "max_stock_purchase" | "min_etf_purchase" | "max_etf_purchase"
  | "max_daily_invest_pct" | "stop_loss_pct" | "deterioration_score" | "deterioration_days"
  | "trailing_profit_trigger" | "trailing_profit_giveback" | "nifty_fall_threshold" | "bad_news_headline_limit">;

export const EDITABLE: Record<EditableKey, { type: "int" | "float"; label: string; group: string }> = {
  total_capital: { type: "float", label: "Total Capital (₹)", group: "Capital" },
  cash_reserve_pct: { type: "float", label: "Cash Reserve %", group: "Allocation" },
  gold_silver_pct: { type: "float", label: "Gold + Silver ETF %", group: "Allocation" },
  nifty50_pct: { type: "float", label: "Nifty 50 %", group: "Allocation" },
  nifty_next100_pct: { type: "float", label: "Nifty Next 100 %", group: "Allocation" },
  smallcap_pct: { type: "float", label: "Smallcap %", group: "Allocation" },
  min_stock_purchase: { type: "float", label: "Min Stock Buy (₹)", group: "Purchase bands" },
  max_stock_purchase: { type: "float", label: "Max Stock Buy (₹)", group: "Purchase bands" },
  min_etf_purchase: { type: "float", label: "Min ETF Buy (₹)", group: "Purchase bands" },
  max_etf_purchase: { type: "float", label: "Max ETF Buy (₹)", group: "Purchase bands" },
  max_daily_invest_pct: { type: "float", label: "Max Daily Invest %", group: "Limits" },
  stop_loss_pct: { type: "float", label: "Stop Loss %", group: "Sell rules" },
  deterioration_score: { type: "float", label: "Deterioration Score Floor", group: "Sell rules" },
  deterioration_days: { type: "int", label: "Deterioration Days", group: "Sell rules" },
  trailing_profit_trigger: { type: "float", label: "Trailing Profit Trigger %", group: "Sell rules" },
  trailing_profit_giveback: { type: "float", label: "Trailing Giveback %", group: "Sell rules" },
  nifty_fall_threshold: { type: "float", label: "Nifty Fall Threshold %", group: "Guards" },
  bad_news_headline_limit: { type: "int", label: "Bad-news Headline Limit", group: "Guards" },
};

export const ALLOC_KEYS: EditableKey[] = [
  "cash_reserve_pct", "gold_silver_pct", "nifty50_pct", "nifty_next100_pct", "smallcap_pct",
];

function cast(value: string, t: "int" | "float"): number {
  const f = Number(value);
  if (Number.isNaN(f)) throw new Error("bad number");
  return t === "int" ? Math.trunc(f) : f;
}

/** All app_settings rows as typed values. */
export function readOverrides(): Partial<Record<EditableKey, number>> {
  const out: Partial<Record<EditableKey, number>> = {};
  for (const r of db.query("SELECT key, value FROM app_settings")) {
    const key = String(r.key) as EditableKey;
    if (key in EDITABLE) {
      try {
        out[key] = cast(String(r.value), EDITABLE[key].type);
      } catch {
        /* ignore junk */
      }
    }
  }
  return out;
}

export function liveSettings(): Settings {
  try {
    return { ...BASE, ...readOverrides() };
  } catch {
    return BASE;
  }
}

export function withOverrides(s: Settings, o: Partial<Settings>): Settings {
  return { ...s, ...o };
}
