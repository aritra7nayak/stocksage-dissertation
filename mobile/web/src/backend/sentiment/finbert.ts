/**
 * FinBERT on the phone — app/sentiment/finbert.py.
 *
 * Tokenization (BERT uncased WordPiece, max_length 96) happens here in
 * TypeScript; the int8 ONNX model runs natively (onnxruntime-android) via the
 * platform seam. Label order comes from the exported model config, never
 * hardcoded. Any failure degrades to NEUTRAL/0 with model_used=false — the
 * pipeline then leans on keyword severity alone, exactly like the server.
 */
import { log, platform } from "../platform";
import { pyRound } from "../util/py";

export interface SentimentResult {
  headline: string;
  sentiment: string;     // POSITIVE | NEGATIVE | NEUTRAL
  score: number;         // P(pos) − P(neg)
  confidence: number;
  model_used: boolean;
}

const MAX_LEN = 96;
const BATCH = 16;

// ── WordPiece tokenizer (BertTokenizer, do_lower_case=True) ──────────────────
export class WordPiece {
  private vocab = new Map<string, number>();
  readonly cls: number;
  readonly sep: number;
  readonly unk: number;

  constructor(vocabText: string) {
    vocabText.split(/\r?\n/).forEach((tok, i) => {
      if (tok !== "" && !this.vocab.has(tok)) this.vocab.set(tok, i);
    });
    this.cls = this.vocab.get("[CLS]")!;
    this.sep = this.vocab.get("[SEP]")!;
    this.unk = this.vocab.get("[UNK]")!;
  }

  private static isPunct(ch: string): boolean {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
    return /\p{P}/u.test(ch);
  }

  private static isCjk(cp: number): boolean {
    return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
  }

  /** BasicTokenizer: clean → CJK spacing → lowercase + strip accents → split punctuation. */
  basic(text: string): string[] {
    let clean = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd) continue;
      if (ch === "\t" || ch === "\n" || ch === "\r" || /\s/u.test(ch)) { clean += " "; continue; }
      if (/[\p{Cc}\p{Cf}]/u.test(ch)) continue;
      clean += WordPiece.isCjk(cp) ? ` ${ch} ` : ch;
    }
    const out: string[] = [];
    for (let word of clean.trim().split(/ +/)) {
      if (!word) continue;
      word = word.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
      let cur = "";
      for (const ch of word) {
        if (WordPiece.isPunct(ch)) {
          if (cur) out.push(cur);
          out.push(ch);
          cur = "";
        } else cur += ch;
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  wordpiece(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > 100) return [this.unk];
    const ids: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        let sub = chars.slice(start, end).join("");
        if (start > 0) sub = `##${sub}`;
        const id = this.vocab.get(sub);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found === undefined) return [this.unk];
      ids.push(found);
      start = end;
    }
    return ids;
  }

  /** [CLS] tokens… [SEP], truncated to maxLen. */
  encode(text: string, maxLen = MAX_LEN): number[] {
    const ids: number[] = [];
    for (const w of this.basic(text)) ids.push(...this.wordpiece(w));
    return [this.cls, ...ids.slice(0, maxLen - 2), this.sep];
  }
}

let tokenizer: WordPiece | null = null;
let labels: string[] = [];
let loadFailed = false;
let modelUsedLast = false;

async function load(): Promise<boolean> {
  if (tokenizer) return true;
  if (loadFailed) return false;
  try {
    const assets = await platform().finbertAssets();
    if (!assets) throw new Error("FinBERT model not bundled");
    tokenizer = new WordPiece(assets.vocab);
    labels = assets.labels.map((l) => l.toUpperCase());
    return true;
  } catch (e) {
    log("warn", `FinBERT unavailable — keyword-only classification (${(e as Error).message})`);
    loadFailed = true;
    return false;
  }
}

const neutral = (h: string): SentimentResult => ({ headline: h, sentiment: "NEUTRAL", score: 0, confidence: 0, model_used: false });

function softmax(logits: number[]): number[] {
  const m = Math.max(...logits);
  const e = logits.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

export async function scoreHeadlines(headlines: string[]): Promise<SentimentResult[]> {
  if (!headlines.length) return [];
  if (!(await load()) || !tokenizer) return headlines.map(neutral);
  const pos = labels.findIndex((l) => l.startsWith("POS"));
  const neg = labels.findIndex((l) => l.startsWith("NEG"));
  const results: SentimentResult[] = [];
  try {
    for (let i = 0; i < headlines.length; i += BATCH) {
      const batch = headlines.slice(i, i + BATCH);
      const enc = batch.map((h) => tokenizer!.encode(h));
      const width = Math.max(...enc.map((e) => e.length));
      const ids = enc.map((e) => [...e, ...new Array(width - e.length).fill(0)]);
      const mask = enc.map((e) => [...new Array(e.length).fill(1), ...new Array(width - e.length).fill(0)]);
      const logits = await platform().finbert(ids, mask);
      if (!logits) throw new Error("model returned nothing");
      batch.forEach((h, k) => {
        const p = softmax(logits[k]);
        let top = 0;
        for (let j = 1; j < p.length; j++) if (p[j] > p[top]) top = j;
        results.push({
          headline: h, sentiment: labels[top], score: pyRound(p[pos] - p[neg], 3),
          confidence: pyRound(p[top], 3), model_used: true,
        });
      });
    }
    modelUsedLast = true;
  } catch (e) {
    log("error", `FinBERT inference error — neutral fallback for this batch (${(e as Error).message})`);
    results.push(...headlines.slice(results.length).map(neutral));
  }
  return results;
}

export function modelStatus() {
  const loaded = tokenizer !== null;
  return {
    loaded,
    device: loaded ? (platform().name === "android" ? "phone (onnxruntime, int8)" : "cpu (onnxruntime)") : null,
    load_failed: loadFailed,
    model: "ProsusAI/finbert (8-bit ONNX)",
    used_last_run: modelUsedLast,
  };
}
