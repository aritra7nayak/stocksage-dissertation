/**
 * Backtest — app/backtest/{series,simulator}.py.
 *
 * Replays the EXACT live rule engine (planBuys + evaluateSell) over history.
 * Composite = technical score only (no historical news/fundamentals), trades
 * at the day's close, 0.12% cost per side. Sells are never gated by R11/R12.
 */
import type { Settings } from "../config";
import { computeSectorHealth, planBuys } from "../engine/core";
import type { Bars } from "../market/yahoo";
import { BuyCandidate, evaluateSell, marketState, PortfolioState } from "../rules/rules";
import { pyRound } from "../util/py";
import { diff, ewm, rollingMax, rollingMean, rollingStd, std } from "../util/series";

export const COST_PCT = 0.0012;

export interface Frame {
  dates: string[];
  close: number[];
  rsi: number[];
  macd_hist: number[];
  macd_above: number[];
  ema20: number[];
  ema50: number[];
  ema_above: number[];
  bb_b: number[];
  vol_ratio: number[];
  dist52: number[];
  day_chg: number[];
}

export function indicatorFrame(df: Bars): Frame {
  const close = df.close, vol = df.volume;
  const delta = diff(close);
  const gain = ewm(delta.map((d) => (Number.isNaN(d) ? NaN : Math.max(d, 0))), { alpha: 1 / 14, minPeriods: 14 });
  const loss = ewm(delta.map((d) => (Number.isNaN(d) ? NaN : Math.max(-d, 0))), { alpha: 1 / 14, minPeriods: 14 });
  const rsi = gain.map((g, i) => {
    const l = loss[i];
    if (l !== 0) return 100 - 100 / (1 + g / l);
    return g > 0 ? 100 : 50;
  });
  const e12 = ewm(close, { span: 12, adjust: false });
  const e26 = ewm(close, { span: 26, adjust: false });
  const macd = e12.map((x, i) => x - e26[i]);
  const sig = ewm(macd, { span: 9, adjust: false });
  const ema20 = ewm(close, { span: 20, adjust: false });
  const ema50 = ewm(close, { span: 50, adjust: false });
  const mid = rollingMean(close, 20);
  const sd = rollingStd(close, 20);
  const volMean = rollingMean(vol, 20);
  const hi52 = rollingMax(close, 252, 60);
  return {
    dates: df.dates,
    close,
    rsi,
    macd_hist: macd.map((m, i) => m - sig[i]),
    macd_above: macd.map((m, i) => (m > sig[i] ? 1 : 0)),
    ema20,
    ema50,
    ema_above: ema20.map((e, i) => (e > ema50[i] ? 1 : 0)),
    bb_b: close.map((c, i) => {
      const width = 4 * sd[i];
      return width === 0 || Number.isNaN(width) ? NaN : (c - (mid[i] - 2 * sd[i])) / width;
    }),
    vol_ratio: vol.map((v, i) => v / volMean[i]),
    dist52: close.map((c, i) => 1 - c / hi52[i]),
    day_chg: close.map((c, i) => (i === 0 ? NaN : (c / close[i - 1] - 1) * 100)),
  };
}

function flips(xs: number[], from: number, to: number): { up: boolean; down: boolean } {
  let up = false, down = false;
  for (let k = from + 1; k <= to; k++) {
    const d = xs[k] - xs[k - 1];
    if (d === 1) up = true;
    else if (d === -1) down = true;
  }
  return { up, down };
}

/** Technical score for row i — mirrors series.tech_score_at. */
export function techScoreAt(f: Frame, i: number): number {
  if (i < 60) return 0.5;
  const price = f.close[i], e20 = f.ema20[i], e50 = f.ema50[i];

  const ef = flips(f.ema_above, Math.max(0, i - 5), i);
  const trend = ef.up ? 1.0 : ef.down ? 0.0 : e20 > e50 && price > e20 ? 0.9 : e20 > e50 ? 0.6 : price > e20 ? 0.4 : 0.1;

  const r = f.rsi[i];
  const rsiS = Number.isNaN(r) ? 0.5 : r >= 45 && r <= 65 ? 1.0 : r >= 30 && r < 45 ? 0.7 : r < 30 ? 0.5 : r <= 75 ? 0.4 : 0.1;

  const mf = flips(f.macd_above, Math.max(0, i - 3), i);
  const macdS = mf.up ? 1.0 : mf.down ? 0.0 : f.macd_hist[i] > 0 ? 0.7 : 0.2;

  const b = f.bb_b[i];
  let pos = Number.isNaN(b) ? 0.6 : b > 1.0 ? 0.1 : b > 0.8 ? 0.4 : b < 0.0 ? 0.4 : b < 0.25 ? 0.8 : 0.6;
  if (f.dist52[i] > 0.3) pos = Math.max(0, pos - 0.2);

  const v = f.vol_ratio[i];
  const upDay = f.day_chg[i] >= 0;
  const volS = !Number.isNaN(v) && v > 1.2 ? (upDay ? 1.0 : 0.2) : 0.5;

  let score = pyRound(0.28 * trend + 0.22 * rsiS + 0.22 * macdS + 0.17 * pos + 0.11 * volS, 3);
  const chop = price ? std(f.close.slice(Math.max(0, i - 20), i + 1)) / price : 0;
  if (chop < 0.005) score = Math.min(score, 0.55);
  return score;
}

export interface SimTrade {
  symbol: string; action: string; trade_date: string; quantity: number; price: number;
  pnl: number | null; triggered_rule: string | null; reason: string;
}

export interface BacktestResult {
  start_date: string; end_date: string; initial_capital: number; final_value: number;
  total_return_pct: number; nifty_return_pct: number; max_drawdown_pct: number; win_rate: number;
  total_trades: number; open_positions: number; trades: SimTrade[];
  equity_curve: { date: string; equity: number }[]; notes: string[];
}

interface SimHolding {
  symbol: string; segment: string; sector: string; quantity: number; avg_buy_price: number;
  cost_paid: number; peak_price: number; low_score_streak: number;
}

const EQUITY = new Set(["NIFTY50", "NEXT100", "SMALLCAP"]);

export class BacktestSimulator {
  private frames: Record<string, Frame> = {};
  private idx: Record<string, Map<string, number>> = {};
  private niftyDates: string[];
  private niftyClose: number[];

  constructor(prices: Record<string, Bars>, private meta: Record<string, [string, string]>, nifty: Bars,
              private s: Settings) {
    this.niftyDates = nifty.dates;
    this.niftyClose = nifty.close;
    for (const [sym, df] of Object.entries(prices)) {
      if (!df || df.close.length < 80 || !meta[sym]) continue;
      this.frames[sym] = indicatorFrame(df);
      this.idx[sym] = new Map(df.dates.map((d, i) => [d, i]));
    }
  }

  /** Same simulator, different rules (presets reuse the precomputed frames). */
  withSettings(s: Settings): BacktestSimulator {
    const clone = Object.create(BacktestSimulator.prototype) as BacktestSimulator;
    Object.assign(clone, this, { s });
    return clone;
  }

  private price(sym: string, d: string): number | null {
    const i = this.idx[sym].get(d);
    return i === undefined ? null : this.frames[sym].close[i];
  }

  run(start: string, end: string, initialCapital?: number): BacktestResult {
    const s = this.s;
    const capital = initialCapital || s.total_capital;
    const res: BacktestResult = {
      start_date: start, end_date: end, initial_capital: capital, final_value: 0, total_return_pct: 0,
      nifty_return_pct: 0, max_drawdown_pct: 0, win_rate: 0, total_trades: 0, open_positions: 0,
      trades: [], equity_curve: [],
      notes: ["Composite = technical score only (no historical news/fundamentals). " +
        "This validates technical signals + rule discipline, not sentiment."],
    };
    let cash = capital;
    const holdings = new Map<string, SimHolding>();
    const days = this.niftyDates.filter((d) => d >= start && d <= end);
    if (days.length < 30) {
      res.notes.push("Window too short / no trading days — aborted.");
      return res;
    }
    const niftyIdx = new Map(this.niftyDates.map((d, i) => [d, i]));
    let peakEquity = capital, maxDd = 0, wins = 0, sellCount = 0;

    for (const d of days) {
      const ni = niftyIdx.get(d);
      if (ni === undefined || ni < 1) continue;
      const nc = this.niftyClose;
      const prevChg = ni >= 2 ? (nc[ni - 1] / nc[ni - 2] - 1) * 100 : 0;
      const niftyFell = prevChg <= s.nifty_fall_threshold;

      const scores: Record<string, number> = {}, dayChg: Record<string, number> = {}, rsiToday: Record<string, number> = {};
      for (const [sym, f] of Object.entries(this.frames)) {
        const i = this.idx[sym].get(d);
        if (i === undefined || i < 60) continue;
        scores[sym] = techScoreAt(f, i);
        dayChg[sym] = f.day_chg[i];
        rsiToday[sym] = Number.isNaN(f.rsi[i]) ? 50 : f.rsi[i];
      }

      for (const h of holdings.values()) {
        const p = this.price(h.symbol, d);
        if (p === null) continue;
        h.peak_price = Math.max(h.peak_price, p);
        const sc = scores[h.symbol];
        if (sc !== undefined) h.low_score_streak = sc < s.deterioration_score ? h.low_score_streak + 1 : 0;
      }

      // SELLS first — capital protection is never gated
      for (const sym of [...holdings.keys()]) {
        const h = holdings.get(sym)!;
        const p = this.price(sym, d);
        if (p === null) continue;
        const ev = evaluateSell(sym, h.avg_buy_price, p, h.peak_price, h.low_score_streak, s);
        if (ev.should_sell) {
          const proceeds = h.quantity * p * (1 - COST_PCT);
          const pnl = pyRound(proceeds - h.cost_paid, 2);
          cash += proceeds;
          res.trades.push({ symbol: sym, action: "SELL", trade_date: d, quantity: h.quantity, price: pyRound(p, 2),
            pnl, triggered_rule: ev.triggered_rule, reason: ev.reason.slice(0, 160) });
          sellCount++;
          if (pnl > 0) wins++;
          holdings.delete(sym);
        }
      }

      // BUYS through the real planner
      const equitySyms: Record<string, string> = {};
      for (const sym of Object.keys(scores)) if (EQUITY.has(this.meta[sym][0])) equitySyms[sym] = this.meta[sym][1];
      const health = computeSectorHealth(equitySyms, dayChg, rsiToday, {}, s.tracked_sectors);
      const market = marketState({
        nifty_fell: niftyFell, nifty_change_pct: prevChg, guard_basis: "previous session (backtest)",
        weak_sectors: new Set(health.filter((h) => h.status === "WEAK").map((h) => h.sector)),
      });
      const bucketDep: Record<string, number> = {}, sectorDep: Record<string, number> = {};
      let mktValue = 0;
      for (const h of holdings.values()) {
        const p = this.price(h.symbol, d) ?? h.avg_buy_price;
        mktValue += h.quantity * p;
        const cost = h.quantity * h.avg_buy_price;
        bucketDep[h.segment] = (bucketDep[h.segment] ?? 0) + cost;
        if (EQUITY.has(h.segment)) sectorDep[h.sector] = (sectorDep[h.sector] ?? 0) + cost;
      }
      const pstate: PortfolioState = {
        total_capital: cash + mktValue, cash_balance: cash, invested_today: 0,
        bucket_deployed: bucketDep, sector_deployed: sectorDep, held_symbols: new Set(holdings.keys()),
      };
      const candidates: BuyCandidate[] = Object.entries(scores).map(([sym, sc]) => ({
        symbol: sym, segment: this.meta[sym][0], sector: this.meta[sym][1],
        price: this.frames[sym].close[this.idx[sym].get(d)!], composite_score: sc,
        is_etf: this.meta[sym][0] === "GOLD_ETF" || this.meta[sym][0] === "SILVER_ETF",
      }));
      const [buys] = planBuys(candidates, pstate, market, s);
      for (const ev of buys) {
        const c = ev.candidate;
        const cost = ev.total_cost * (1 + COST_PCT);
        if (cost > cash) continue;
        cash -= cost;
        holdings.set(c.symbol, { symbol: c.symbol, segment: c.segment, sector: c.sector, quantity: ev.quantity,
          avg_buy_price: c.price, cost_paid: cost, peak_price: c.price, low_score_streak: 0 });
        res.trades.push({ symbol: c.symbol, action: "BUY", trade_date: d, quantity: ev.quantity,
          price: pyRound(c.price, 2), pnl: null, triggered_rule: null, reason: `score ${c.composite_score}` });
      }

      let equity = cash;
      for (const h of holdings.values()) equity += (this.price(h.symbol, d) ?? h.avg_buy_price) * h.quantity;
      peakEquity = Math.max(peakEquity, equity);
      maxDd = Math.max(maxDd, (peakEquity - equity) / peakEquity);
      res.equity_curve.push({ date: d, equity: pyRound(equity, 2) });
    }

    const final = res.equity_curve.length ? res.equity_curve[res.equity_curve.length - 1].equity : capital;
    res.final_value = final;
    res.total_return_pct = pyRound((final / capital - 1) * 100, 3);
    const n0 = this.niftyClose[this.niftyDates.findIndex((d) => d >= days[0])];
    let i1 = -1;
    this.niftyDates.forEach((d, i) => { if (d <= days[days.length - 1]) i1 = i; });
    res.nifty_return_pct = pyRound((this.niftyClose[i1] / n0 - 1) * 100, 3);
    res.max_drawdown_pct = pyRound(maxDd * 100, 3);
    res.total_trades = res.trades.length;
    res.open_positions = holdings.size;
    res.win_rate = sellCount ? pyRound(wins / sellCount, 3) : 0;
    return res;
  }
}
