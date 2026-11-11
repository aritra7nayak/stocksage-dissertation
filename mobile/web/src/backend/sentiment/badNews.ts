/**
 * India-specific bad-news classification — app/sentiment/bad_news.py (v2).
 * Word-boundary matching, systemic vs company keywords, market-scope
 * promotion, and evidence on every verdict. Pure and deterministic.
 */
import { sha256Hex } from "../util/hash";

const SYSTEMIC_KEYWORDS: Record<string, number> = {
  "circuit breaker": 10, "trading halted": 10, "market crash": 10,
  "market meltdown": 9, "bloodbath on dalal street": 9, "black monday": 9,
  war: 9, invasion: 9, missile: 9, "air strike": 9, airstrike: 9,
  "terror attack": 10, nuclear: 9, "emergency declared": 10,
  pandemic: 9, lockdown: 9, curfew: 8,
  "sovereign downgrade": 9, "rupee collapses": 9, "rupee crashes": 9,
  "gdp contracts": 7, recession: 6, "recession fears": 6,
  "fii sell-off": 6, "fii selloff": 6, "fiis pull out": 6,
  sanctions: 6, "trade war": 6,
};

const COMPANY_KEYWORDS: Record<string, number> = {
  "sebi bars": 8, "sebi bans": 8, "sebi crackdown": 8, "sebi probe": 7, "sebi order": 7,
  fraud: 8, scam: 8, "money laundering": 8, "ed raids": 7, "cbi probe": 7,
  default: 8, defaults: 8, bankruptcy: 8, insolvency: 8, nclt: 7,
  "rating downgrade": 7, "downgraded to junk": 8, "auditor resigns": 8,
  crashes: 8, plunges: 7, plummets: 7, tanks: 7, sinks: 7, nosedives: 7,
  "rbi restricts": 8, "rbi penalty": 7, "license cancelled": 8, "promoter pledge": 6,
  "shuts down": 6, "mass layoffs": 6, bloodbath: 7,
  "rbi hikes": 6, "rate hike": 5, "repo rate raised": 6, "inflation surges": 6,
  "foreign outflows": 5, tariff: 5, "crude surges": 5, "oil spikes": 5,
  "slowdown deepens": 5, "gst hike": 5, "windfall tax": 5,
  "sell-off": 5, selloff: 5, layoffs: 5, strike: 4,
  "misses estimates": 4, "profit falls": 4, "profit drops": 4, "loss widens": 5,
  "weak guidance": 4, downgrade: 4, "cuts target": 3, "margin pressure": 3,
  slips: 3, declines: 3, falls: 3, drops: 3,
};

const MARKET_SCOPE_TERMS = [
  "sensex", "nifty", "dalal street", "d-street", "stock market", "equity market",
  "markets", "indices", "benchmark", "broader market", "midcap index", "smallcap index",
];

export const SECTOR_KEYWORDS: Record<string, string[]> = {
  IT: ["it sector", "software", "infosys", "tcs", "wipro", "hcl", "tech mahindra",
    "it services", "nasscom", "h-1b", "tech stocks", "ltimindtree"],
  "Banking & Finance": ["bank", "banking", "rbi", "nbfc", "hdfc", "icici", "sbi", "axis",
    "kotak", "lender", "npa", "credit growth", "insurance", "mutual fund",
    "psu bank", "repo rate", "finance company"],
  "Pharma & Healthcare": ["pharma", "drug", "usfda", "fda", "hospital", "healthcare",
    "vaccine", "api maker", "sun pharma", "cipla", "biocon"],
  "Oil & Gas": ["crude", "oil", "opec", "brent", "ongc", "refinery", "petroleum",
    "natural gas", "lng", "reliance industries"],
  Metal: ["steel", "metal", "copper", "aluminium", "iron ore", "zinc", "tata steel",
    "jsw", "hindalco", "vedanta", "mining"],
  "Energy & Power": ["power", "electricity", "coal", "renewable", "solar", "wind energy",
    "ntpc", "discom", "grid", "adani power", "thermal"],
  Manufacturing: ["auto", "automobile", "cement", "manufacturing", "capex", "defence",
    "maruti", "tata motors", "mahindra", "l&t", "construction", "infra",
    "chemicals", "ev maker", "two-wheeler"],
  FMCG: ["fmcg", "consumer goods", "hindustan unilever", "itc", "nestle", "britannia",
    "dabur", "staples", "rural demand"],
  Services: ["airline", "aviation", "telecom", "airtel", "jio", "retail", "real estate",
    "realty", "e-commerce", "logistics", "hotel", "railways", "port"],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wb = (kw: string) => new RegExp(`(?<![a-z0-9])${esc(kw)}(?![a-z0-9])`);

const SYSTEMIC = Object.entries(SYSTEMIC_KEYWORDS).map(([kw, sev]) => ({ re: wb(kw), kw, sev }));
const COMPANY = Object.entries(COMPANY_KEYWORDS).map(([kw, sev]) => ({ re: wb(kw), kw, sev }));
const MARKET_SCOPE = MARKET_SCOPE_TERMS.map(wb);
const SECTOR = Object.entries(SECTOR_KEYWORDS).map(([sec, kws]) => ({ sec, res: kws.map(wb) }));

const BENIGN: [RegExp, string][] = [
  [/think[- ]tanks?/g, "policy institutes"],
  [/price wars?/g, "price competition"],
  [/bidding wars?/g, "bidding contest"],
  [/war of words/g, "spat"],
  [/war chest/g, "cash reserves"],
  [/post[- ]war/g, "post-conflict-era"],
];

export interface HeadlineClassification {
  headline: string;
  severity: number;
  matched_keywords: string[];
  sectors: string[];
  is_severe: boolean;
  is_bad: boolean;
  is_systemic: boolean;
}

export function classifyHeadline(headline: string): HeadlineClassification {
  let text = headline.toLowerCase().replace(/\s+/g, " ");
  for (const [re, repl] of BENIGN) text = text.replace(re, repl);
  const c: HeadlineClassification = {
    headline, severity: 0, matched_keywords: [], sectors: [], is_severe: false, is_bad: false, is_systemic: false,
  };
  for (const { re, kw, sev } of SYSTEMIC) {
    if (re.test(text)) {
      c.matched_keywords.push(kw);
      c.severity = Math.max(c.severity, sev);
      c.is_systemic = true;
    }
  }
  for (const { re, kw, sev } of COMPANY) {
    if (re.test(text)) {
      c.matched_keywords.push(kw);
      c.severity = Math.max(c.severity, sev);
    }
  }
  for (const { sec, res } of SECTOR) if (res.some((r) => r.test(text))) c.sectors.push(sec);
  c.is_severe = c.severity >= 6;
  c.is_bad = c.severity >= 4;
  if (c.is_severe && !c.is_systemic && MARKET_SCOPE.some((r) => r.test(text))) {
    c.is_systemic = true;
    c.matched_keywords.push("market-scope");
  }
  return c;
}

export function combineWithSentiment(c: HeadlineClassification, sentiment: string, score: number): HeadlineClassification {
  if (sentiment === "NEGATIVE" && score <= -0.6 && c.severity < 4) {
    c.severity = Math.max(c.severity, 4);
    c.is_bad = true;
    c.matched_keywords.push("finbert:strong-negative");
  }
  return c;
}

export function marketGuardFromToday(cs: HeadlineClassification[], severeLimit: number) {
  const severe = cs.filter((c) => c.is_severe);
  const systemic = severe.filter((c) => c.is_systemic);
  const counts: Record<string, number> = {};
  for (const c of severe) for (const sec of c.sectors) counts[sec] = (counts[sec] ?? 0) + 1;
  const blocked = Object.entries(counts).filter(([, n]) => n >= 2).map(([s]) => s).sort();
  const ev = (c: HeadlineClassification) => ({
    headline: c.headline, severity: c.severity, keywords: c.matched_keywords.slice(0, 6),
    systemic: c.is_systemic, sectors: c.sectors,
  });
  return {
    severe_count: severe.length,
    systemic_count: systemic.length,
    market_stopped: systemic.length > severeLimit,
    blocked_sectors: blocked,
    severe_headlines: severe.map((c) => c.headline).slice(0, 10),
    evidence: (systemic.length ? systemic : severe).map(ev).slice(0, 10),
  };
}

export function urlHash(url: string, headline: string): Promise<string> {
  return sha256Hex(`${url}|${headline}`).then((h) => h.slice(0, 64));
}
