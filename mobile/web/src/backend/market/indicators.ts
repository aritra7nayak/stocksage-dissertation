/**
 * Technical indicators — app/market_data/indicators.py, line for line.
 * Same formulas, same pandas smoothing semantics (see util/series.ts), same
 * thresholds and the same plain-English reasons.
 */
import { fmt, pyRound } from "../util/py";
import {
  diff, ewm, last, rollingMax, rollingMean, rollingMin, rollingStd, shift, std, Series,
} from "../util/series";
import type { Bars } from "./yahoo";

export function rsi(close: Series, period = 14): number {
  const delta = diff(close);
  const gain = ewm(delta.map((d) => (Number.isNaN(d) ? NaN : Math.max(d, 0))), { alpha: 1 / period, minPeriods: period });
  const loss = ewm(delta.map((d) => (Number.isNaN(d) ? NaN : Math.max(-d, 0))), { alpha: 1 / period, minPeriods: period });
  const g = last(gain), l = last(loss);
  let val: number;
  if (l !== 0) {
    const rs = g / l;                       // NaN propagates when still warming up
    val = 100 - 100 / (1 + rs);
  } else {
    val = g > 0 ? 100 : 50;
  }
  return Number.isNaN(val) ? 50 : pyRound(val, 2);
}

function crossFlags(above: number[], lookback: number): "UP" | "DOWN" | "NONE" {
  const flips = diff(above).slice(-lookback);
  if (flips.some((f) => f === 1)) return "UP";
  if (flips.some((f) => f === -1)) return "DOWN";
  return "NONE";
}

export function macd(close: Series): [number, string] {
  const e12 = ewm(close, { span: 12, adjust: false });
  const e26 = ewm(close, { span: 26, adjust: false });
  const line = e12.map((x, i) => x - e26[i]);
  const signal = ewm(line, { span: 9, adjust: false });
  const hist = line.map((x, i) => x - signal[i]);
  const c = crossFlags(line.map((x, i) => (x > signal[i] ? 1 : 0)), 3);
  return [pyRound(last(hist), 4), c === "UP" ? "BULLISH_CROSS" : c === "DOWN" ? "BEARISH_CROSS" : "NONE"];
}

export function emaSeries(close: Series, span: number): Series {
  return ewm(close, { span, adjust: false });
}

export function ema(close: Series, span: number): number {
  return pyRound(last(emaSeries(close, span)), 2);
}

export function emaCross(close: Series): string {
  const e20 = emaSeries(close, 20), e50 = emaSeries(close, 50);
  const c = crossFlags(e20.map((x, i) => (x > e50[i] ? 1 : 0)), 5);
  return c === "UP" ? "GOLDEN" : c === "DOWN" ? "DEATH" : "NONE";
}

export function bollingerPercentB(close: Series, period = 20, numStd = 2): number {
  const mid = last(rollingMean(close, period));
  const sd = last(rollingStd(close, period));
  const upper = mid + numStd * sd, lower = mid - numStd * sd;
  const width = upper - lower;
  if (width === 0 || Number.isNaN(width)) return 0.5;
  return pyRound((last(close) - lower) / width, 3);
}

export function adx(high: Series, low: Series, close: Series, period = 14): number {
  const up = diff(high);
  const down = diff(low).map((x) => -x);
  const plusDm = up.map((u, i) => (u > down[i] && u > 0 ? u : 0));
  const minusDm = down.map((d, i) => (d > up[i] && d > 0 ? d : 0));
  const prevClose = shift(close);
  const tr = high.map((h, i) => {
    const vals = [h - low[i], Math.abs(h - prevClose[i]), Math.abs(low[i] - prevClose[i])].filter((v) => !Number.isNaN(v));
    return vals.length ? Math.max(...vals) : NaN;
  });
  const o = { alpha: 1 / period, minPeriods: period };
  const atr = ewm(tr, o);
  const pSm = ewm(plusDm, o), mSm = ewm(minusDm, o);
  const pdi = pSm.map((x, i) => (100 * x) / atr[i]);
  const mdi = mSm.map((x, i) => (100 * x) / atr[i]);
  const dx = pdi.map((p, i) => {
    const den = p + mdi[i];
    return den === 0 || Number.isNaN(den) ? NaN : (100 * Math.abs(p - mdi[i])) / den;
  });
  const val = last(ewm(dx, o));
  return Number.isNaN(val) ? 0 : pyRound(val, 2);
}

export function stochasticK(high: Series, low: Series, close: Series, period = 14): number {
  const lowest = rollingMin(low, period), highest = rollingMax(high, period);
  const raw = close.map((c, i) => {
    const rng = highest[i] - lowest[i];
    return rng === 0 || Number.isNaN(rng) ? NaN : (100 * (c - lowest[i])) / rng;
  });
  const val = last(rollingMean(raw, 3));
  return Number.isNaN(val) ? 50 : pyRound(val, 2);
}

export function volumeRatio(volume: Series, period = 20): number {
  const sma = last(rollingMean(volume, period));
  if (sma === 0 || Number.isNaN(sma)) return 1;
  return pyRound(last(volume) / sma, 3);
}

export function momentum(close: Series, period = 20): number {
  if (close.length <= period) return 0;
  return pyRound(last(close) / close[close.length - period - 1] - 1, 4);
}

export function distFrom52wHigh(close: Series): number {
  const hi = Math.max(...close.slice(-252));
  return pyRound(1 - last(close) / hi, 3);
}

export interface TechnicalSnapshot {
  rsi_14: number;
  macd_hist: number;
  macd_signal: string;
  ema_20: number;
  ema_50: number;
  ema_cross: string;
  bb_percent_b: number;
  adx: number;
  stoch_k: number;
  volume_ratio: number;
  momentum_20d: number;
  dist_52w_high: number;
  technical_score: number;
  reasons: string[];
}

function emptySnapshot(reasons: string[]): TechnicalSnapshot {
  return {
    rsi_14: 50, macd_hist: 0, macd_signal: "NONE", ema_20: 0, ema_50: 0, ema_cross: "NONE",
    bb_percent_b: 0.5, adx: 0, stoch_k: 50, volume_ratio: 1, momentum_20d: 0, dist_52w_high: 0,
    technical_score: 0.5, reasons,
  };
}

/** Every indicator plus the weighted 0–1 technical score (see indicators.py). */
export function computeAll(df: Bars | null | undefined, lastBarPartial = false): TechnicalSnapshot {
  if (!df || df.close.length < 60) {
    return emptySnapshot(["Insufficient price history (<60 days) — neutral score."]);
  }
  const close = df.close, high = df.high, low = df.low;
  const vol = lastBarPartial && df.volume.length > 61 ? df.volume.slice(0, -1) : df.volume;

  const [macdHist, macdSignal] = macd(close);
  const snap: TechnicalSnapshot = {
    rsi_14: rsi(close),
    macd_hist: macdHist,
    macd_signal: macdSignal,
    ema_20: ema(close, 20),
    ema_50: ema(close, 50),
    ema_cross: emaCross(close),
    bb_percent_b: bollingerPercentB(close),
    adx: adx(high, low, close),
    stoch_k: stochasticK(high, low, close),
    volume_ratio: volumeRatio(vol),
    momentum_20d: momentum(close),
    dist_52w_high: distFrom52wHigh(close),
    technical_score: 0.5,
    reasons: [],
  };

  const price = last(close);
  const reasons: string[] = [];

  // 1. Trend (0.25)
  let trend: number;
  if (snap.ema_cross === "GOLDEN") {
    trend = 1.0; reasons.push("Golden cross: EMA20 just crossed above EMA50 — fresh uptrend");
  } else if (snap.ema_cross === "DEATH") {
    trend = 0.0; reasons.push("Death cross: EMA20 just crossed below EMA50 — fresh downtrend");
  } else if (snap.ema_20 > snap.ema_50 && price > snap.ema_20) {
    trend = 0.9; reasons.push("Healthy uptrend: price above EMA20, EMA20 above EMA50");
  } else if (snap.ema_20 > snap.ema_50) {
    trend = 0.6; reasons.push("Uptrend intact but price dipped below EMA20 — possible pullback entry");
  } else if (price > snap.ema_20) {
    trend = 0.4; reasons.push("Price recovering above EMA20 but longer trend still down");
  } else {
    trend = 0.1; reasons.push("Downtrend: price below both EMAs");
  }

  // 2. RSI (0.20)
  const r = snap.rsi_14;
  let rsiS: number;
  if (r >= 45 && r <= 65) {
    rsiS = 1.0; reasons.push(`RSI ${fmt(r, ".0f")}: healthy momentum zone, not overbought`);
  } else if (r >= 30 && r < 45) {
    rsiS = 0.7; reasons.push(`RSI ${fmt(r, ".0f")}: cooling off / early recovery`);
  } else if (r < 30) {
    rsiS = 0.5; reasons.push(`RSI ${fmt(r, ".0f")}: oversold — potential value entry but falling knife risk`);
  } else if (r > 65 && r <= 75) {
    rsiS = 0.4; reasons.push(`RSI ${fmt(r, ".0f")}: getting overbought — chasing risk`);
  } else {
    rsiS = 0.1; reasons.push(`RSI ${fmt(r, ".0f")}: heavily overbought — poor entry`);
  }

  // 3. MACD (0.20)
  let macdS: number;
  if (snap.macd_signal === "BULLISH_CROSS") {
    macdS = 1.0; reasons.push("MACD bullish crossover within last 3 sessions");
  } else if (snap.macd_signal === "BEARISH_CROSS") {
    macdS = 0.0; reasons.push("MACD bearish crossover within last 3 sessions");
  } else if (snap.macd_hist > 0) {
    macdS = 0.7; reasons.push("MACD histogram positive — momentum with the bulls");
  } else {
    macdS = 0.2; reasons.push("MACD histogram negative — momentum with the bears");
  }

  // 4. Position (0.15)
  const b = snap.bb_percent_b;
  let pos: number;
  if (b > 1.0) {
    pos = 0.1; reasons.push("Price above upper Bollinger band — stretched");
  } else if (b > 0.8) {
    pos = 0.4;
  } else if (b < 0.0) {
    pos = 0.4; reasons.push("Price below lower Bollinger band — capitulation zone");
  } else if (b < 0.25) {
    pos = 0.8; reasons.push("Price near lower Bollinger band — favourable entry zone");
  } else {
    pos = 0.6;
  }
  if (snap.dist_52w_high > 0.3) {
    pos = Math.max(0, pos - 0.2);
    reasons.push(`Trading ${fmt(snap.dist_52w_high, ".0%")} below 52-week high — verify it's not a falling knife`);
  }

  // 5. ADX (0.10)
  const uptrend = snap.ema_20 > snap.ema_50;
  let adxS: number;
  if (snap.adx > 25 && uptrend) {
    adxS = 1.0; reasons.push(`ADX ${fmt(snap.adx, ".0f")}: strong, confirmed uptrend`);
  } else if (snap.adx > 25) {
    adxS = 0.0; reasons.push(`ADX ${fmt(snap.adx, ".0f")}: strong DOWNtrend — avoid`);
  } else {
    adxS = 0.5;
  }

  // 6. Volume (0.10)
  const v = snap.volume_ratio;
  const upDay = last(close) >= close[close.length - 2];
  let volS: number;
  if (v > 1.2 && upDay) {
    volS = 1.0; reasons.push(`Volume ${fmt(v, ".1f")}× average on an up day — conviction buying`);
  } else if (v > 1.2) {
    volS = 0.2; reasons.push(`Volume ${fmt(v, ".1f")}× average on a down day — distribution warning`);
  } else {
    volS = 0.5;
  }

  snap.technical_score = pyRound(
    0.25 * trend + 0.2 * rsiS + 0.2 * macdS + 0.15 * pos + 0.1 * adxS + 0.1 * volS, 3);

  const chop = price ? std(close.slice(-21)) / price : 0;
  if (chop < 0.005 && snap.technical_score > 0.55) {
    snap.technical_score = 0.55;
    reasons.push("Sideways chop (20d volatility <0.5%) — cross signals treated as noise, score capped");
  }
  snap.reasons = reasons;
  return snap;
}
