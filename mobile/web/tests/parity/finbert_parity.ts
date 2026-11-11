import { readFileSync } from "node:fs";
import { initBackend } from "../../src/backend";
import { scoreHeadlines, WordPiece } from "../../src/backend/sentiment/finbert";
import { MODEL_DIR, nodePlatform } from "../nodePlatform";

initBackend(nodePlatform());
const ref = JSON.parse(readFileSync("tests/parity/finbert_ref.json", "utf8"));
const wp = new WordPiece(readFileSync(`${MODEL_DIR}/vocab.txt`, "utf8"));
let tokBad = 0;
ref.headlines.forEach((h: string, i: number) => {
  const got = wp.encode(h);
  if (JSON.stringify(got) !== JSON.stringify(ref.ids[i])) {
    tokBad++;
    console.log(`TOKEN MISMATCH: ${JSON.stringify(h.slice(0, 60))}\n  hf=${ref.ids[i].join(",")}\n  ts=${got.join(",")}`);
  }
});
const labels = ["POSITIVE", "NEGATIVE", "NEUTRAL"];
const res = await scoreHeadlines(ref.headlines);
let lab = 0, maxd = 0, thr = 0;
res.forEach((r, i) => {
  if (r.sentiment === labels[ref.labels[i]]) lab++;
  maxd = Math.max(maxd, Math.abs(r.score - ref.scores[i]));
  if ((r.score <= -0.6) === (ref.scores[i] <= -0.6)) thr++;
});
console.log(`tokenizer: ${ref.headlines.length - tokBad}/${ref.headlines.length} identical`);
console.log(`phone pipeline vs PyTorch: labels ${lab}/${res.length}, max |score diff| ${maxd.toFixed(3)}, R12 threshold agree ${thr}/${res.length}, model_used=${res[0].model_used}`);
