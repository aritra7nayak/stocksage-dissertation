/**
 * Fundamental scoring — app/market_data/fundamentals.py. Every metric scored
 * 0–10 with a stated reason; missing data scores a neutral 5 and says so.
 */
import { fmt, pyRound } from "../util/py";
import { getFundamentalsRaw } from "./fetcher";

const WEIGHTS = { pe: 0.2, pb: 0.1, roe: 0.2, de: 0.15, growth: 0.15, margin: 0.15, dividend: 0.05 };

export interface FundamentalSnapshot {
  pe_ratio: number | null;
  pb_ratio: number | null;
  roe: number | null;
  debt_to_equity: number | null;
  revenue_growth: number | null;
  profit_margin: number | null;
  dividend_yield: number | null;
  fundamental_score: number;
  reasons: string[];
}

type Scored = [number, string];

function scorePe(pe: number | null): Scored {
  if (pe == null || pe <= 0) return [5, "P/E unavailable or negative earnings — neutral"];
  if (pe < 15) return [10, `P/E ${fmt(pe, ".1f")}: attractively valued`];
  if (pe < 25) return [7, `P/E ${fmt(pe, ".1f")}: fairly valued`];
  if (pe < 40) return [4, `P/E ${fmt(pe, ".1f")}: expensive`];
  return [2, `P/E ${fmt(pe, ".1f")}: very expensive — priced for perfection`];
}

function scorePb(pb: number | null): Scored {
  if (pb == null || pb <= 0) return [5, "P/B unavailable — neutral"];
  if (pb < 2) return [9, `P/B ${fmt(pb, ".1f")}: trading near book value`];
  if (pb < 5) return [6, `P/B ${fmt(pb, ".1f")}: reasonable`];
  return [3, `P/B ${fmt(pb, ".1f")}: rich vs book`];
}

function scoreRoe(roe: number | null): Scored {
  if (roe == null) return [5, "ROE unavailable — neutral"];
  const pct = roe * 100;
  if (pct > 20) return [10, `ROE ${fmt(pct, ".0f")}%: excellent capital efficiency`];
  if (pct > 15) return [8, `ROE ${fmt(pct, ".0f")}%: strong`];
  if (pct > 10) return [6, `ROE ${fmt(pct, ".0f")}%: decent`];
  if (pct > 0) return [3, `ROE ${fmt(pct, ".0f")}%: weak returns on equity`];
  return [1, `ROE ${fmt(pct, ".0f")}%: destroying shareholder value`];
}

function scoreDe(de: number | null): Scored {
  if (de == null) return [5, "Debt/Equity unavailable — neutral"];
  de = de > 10 ? de / 100 : de;          // Yahoo reports this as a percentage
  if (de < 0.3) return [10, `D/E ${fmt(de, ".2f")}: nearly debt-free`];
  if (de < 1.0) return [7, `D/E ${fmt(de, ".2f")}: manageable leverage`];
  if (de < 2.0) return [4, `D/E ${fmt(de, ".2f")}: heavily leveraged`];
  return [1, `D/E ${fmt(de, ".2f")}: dangerous debt load`];
}

function scoreGrowth(g: number | null): Scored {
  if (g == null) return [5, "Revenue growth unavailable — neutral"];
  const pct = g * 100;
  if (pct > 20) return [10, `Revenue growth ${fmt(pct, ".0f")}% YoY: rapid expansion`];
  if (pct > 10) return [8, `Revenue growth ${fmt(pct, ".0f")}% YoY: healthy`];
  if (pct > 0) return [5, `Revenue growth ${fmt(pct, ".0f")}% YoY: slow`];
  return [2, `Revenue shrinking ${fmt(pct, ".0f")}% YoY`];
}

function scoreMargin(m: number | null): Scored {
  if (m == null) return [5, "Profit margin unavailable — neutral"];
  const pct = m * 100;
  if (pct > 20) return [10, `Net margin ${fmt(pct, ".0f")}%: highly profitable`];
  if (pct > 10) return [7, `Net margin ${fmt(pct, ".0f")}%: solid`];
  if (pct > 0) return [4, `Net margin ${fmt(pct, ".0f")}%: thin`];
  return [1, `Loss-making (margin ${fmt(pct, ".0f")}%)`];
}

function scoreDividend(d: number | null): Scored {
  if (d == null || d === 0) return [5, "No dividend — neutral (growth stocks reinvest)"];
  const pct = d < 1 ? d * 100 : d;
  if (pct > 2) return [9, `Dividend yield ${fmt(pct, ".1f")}%: meaningful income`];
  return [7, `Dividend yield ${fmt(pct, ".1f")}%: token payout`];
}

function neutral(reason: string): FundamentalSnapshot {
  return {
    pe_ratio: null, pb_ratio: null, roe: null, debt_to_equity: null, revenue_growth: null,
    profit_margin: null, dividend_yield: null, fundamental_score: 0.5, reasons: [reason],
  };
}

export async function scoreFundamentals(symbol: string, isEtf = false): Promise<FundamentalSnapshot> {
  if (isEtf) return neutral("ETF — fundamentals not applicable, neutral 0.5");
  let info: Record<string, number | null>;
  try {
    info = await getFundamentalsRaw(symbol);
  } catch (e) {
    return neutral(`Fundamentals fetch failed (${(e as Error).message}) — neutral 0.5`);
  }
  const snap: FundamentalSnapshot = {
    pe_ratio: info.trailingPE ?? null,
    pb_ratio: info.priceToBook ?? null,
    roe: info.returnOnEquity ?? null,
    debt_to_equity: info.debtToEquity ?? null,
    revenue_growth: info.revenueGrowth ?? null,
    profit_margin: info.profitMargins ?? null,
    dividend_yield: info.dividendYield ?? null,
    fundamental_score: 0.5,
    reasons: [],
  };
  const parts: [keyof typeof WEIGHTS, Scored][] = [
    ["pe", scorePe(snap.pe_ratio)],
    ["pb", scorePb(snap.pb_ratio)],
    ["roe", scoreRoe(snap.roe)],
    ["de", scoreDe(snap.debt_to_equity)],
    ["growth", scoreGrowth(snap.revenue_growth)],
    ["margin", scoreMargin(snap.profit_margin)],
    ["dividend", scoreDividend(snap.dividend_yield)],
  ];
  let total = 0;
  for (const [k, [s, why]] of parts) {
    total += WEIGHTS[k] * s;
    snap.reasons.push(why);
  }
  snap.fundamental_score = pyRound(total / 10, 3);
  return snap;
}
