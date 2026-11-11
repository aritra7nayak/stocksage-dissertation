"""Reference token ids + scores from Hugging Face / PyTorch for finbert_parity.ts."""
import json, sys
from pathlib import Path
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
here = Path(__file__).parent
H = json.loads((here / "headlines.json").read_text(encoding="utf-8"))
H += ["Café Coffee Day's résumé: naïve über-growth?", "  RBI hikes\trepo  by 25bps!!! ", "中国 stocks rally; ₹1,234.50 cr deal",
      "A" * 130 + " overly long token", " ".join(["word"] * 120), "Q2FY27 EBITDA +12.5% YoY (beat)", ""]
tok = AutoTokenizer.from_pretrained("ProsusAI/finbert")
model = AutoModelForSequenceClassification.from_pretrained("ProsusAI/finbert").eval()
ids = [tok(h, truncation=True, max_length=96)["input_ids"] for h in H]
enc = tok(H, padding=True, truncation=True, max_length=96, return_tensors="pt")
with torch.inference_mode():
    p = torch.softmax(model(**enc).logits, -1)
(here / "finbert_ref.json").write_text(json.dumps({"headlines": H, "ids": ids,
    "scores": [round(float(r[0] - r[1]), 3) for r in p], "labels": [int(r.argmax()) for r in p]}), encoding="utf-8")
print(f"{len(H)} references written")
