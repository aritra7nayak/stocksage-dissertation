"""Export ProsusAI/finbert to a compact ONNX model for the Android app.

Writes mobile/android/app/src/main/assets/finbert/{model.onnx, vocab.txt, labels.json}
and checks the compressed model against PyTorch.

Why this recipe: plain int8 dynamic quantization changed 18 of 87 real
headline labels (it also quantizes activations, which BERT's attention does
not tolerate). Weight-only 8-bit block quantization (MatMulNBits, fp32 math)
plus fp16 embedding tables keeps every label and moves scores by < 0.03,
at 146 MB instead of 438 MB.

Run with the backend venv (it already has torch + transformers):
    backend\\.venv\\Scripts\\python.exe mobile\\scripts\\export_finbert.py [--extra-path DIR]

--extra-path points at a folder holding onnx / onnxscript / onnxruntime if they
aren't installed in the venv itself (pip install --target DIR onnx onnxscript onnxruntime).
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "mobile" / "android" / "app" / "src" / "main" / "assets" / "finbert"
MODEL = "ProsusAI/finbert"

SAMPLES = [
    "Sensex plunges 900 points as FIIs pull out amid global sell-off",
    "Infosys beats estimates, raises FY27 revenue guidance",
    "RBI keeps repo rate unchanged at 6.5%, maintains stance",
    "Tata Steel Q2 profit falls 40% on weak European operations",
    "Adani Ports shares surge 8% after record cargo volumes",
    "Nifty ends flat ahead of US inflation data",
    "SEBI bars promoter from markets over fraud allegations",
    "Maruti Suzuki October sales rise 12% on festive demand",
    "Crude oil spikes 5% after OPEC+ announces surprise output cut",
    "HDFC Bank's loan growth slows to 9% in September quarter",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra-path", help="folder with onnx/onnxruntime if not in the venv")
    args = ap.parse_args()
    if args.extra_path:
        sys.path.append(args.extra_path)   # appended: the venv's numpy/torch keep precedence

    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    import numpy as np
    import onnx
    import onnxruntime as ort
    from onnx import TensorProto, helper, numpy_helper
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    from onnxruntime.quantization.shape_inference import quant_pre_process

    OUT.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL).eval()

    fp32 = OUT / "model_fp32.onnx"
    enc = tok(SAMPLES[:2], padding=True, truncation=True, max_length=96, return_tensors="pt")
    with torch.inference_mode():
        torch.onnx.export(
            model, (enc["input_ids"], enc["attention_mask"], enc["token_type_ids"]), str(fp32),
            input_names=["input_ids", "attention_mask", "token_type_ids"], output_names=["logits"],
            dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"},
                          "token_type_ids": {0: "batch", 1: "seq"}, "logits": {0: "batch"}},
            opset_version=17, dynamo=False,
        )
    pre = OUT / "model_pre.onnx"
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    fp32.unlink()

    # 1. Linear layers: 8-bit weights in blocks of 32, dequantized to fp32 at run time
    q = MatMulNBitsQuantizer(onnx.load(str(pre)), block_size=32, is_symmetric=True, bits=8)
    q.process()
    m = q.model.model
    pre.unlink()

    # 2. Embedding tables: fp16 storage, cast back to fp32 right after the lookup
    inits = {i.name: i for i in m.graph.initializer}
    nodes = []
    for n in m.graph.node:
        nodes.append(n)
        t = inits.get(n.input[0]) if n.op_type == "Gather" else None
        if t is not None and t.data_type == TensorProto.FLOAT and numpy_helper.to_array(t).size > 1000:
            t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float16), t.name))
            out = n.output[0]
            n.output[0] = f"{out}_f16"
            nodes.append(helper.make_node("Cast", [f"{out}_f16"], [out], to=TensorProto.FLOAT, name=f"{n.name}_cast"))
    del m.graph.node[:]
    m.graph.node.extend(nodes)
    onnx.save(m, str(OUT / "model.onnx"))

    (OUT / "vocab.txt").write_text(
        "\n".join(t for t, _ in sorted(tok.get_vocab().items(), key=lambda kv: kv[1])) + "\n", encoding="utf-8")
    labels = [model.config.id2label[i] for i in range(model.config.num_labels)]
    (OUT / "labels.json").write_text(json.dumps(labels), encoding="utf-8")

    # ── verify int8 vs PyTorch ──────────────────────────────────────────────
    sess = ort.InferenceSession(str(OUT / "model.onnx"))
    enc = tok(SAMPLES, padding=True, truncation=True, max_length=96, return_tensors="pt")
    with torch.inference_mode():
        ref = torch.softmax(model(**enc).logits, -1).numpy()
    got = sess.run(None, {k: enc[k].numpy() for k in ("input_ids", "attention_mask", "token_type_ids")})[0]
    got = np.exp(got - got.max(-1, keepdims=True))
    got /= got.sum(-1, keepdims=True)
    pos, neg = labels.index("positive"), labels.index("negative")
    agree = int((ref.argmax(-1) == got.argmax(-1)).sum())
    diff = float(np.abs((ref[:, pos] - ref[:, neg]) - (got[:, pos] - got[:, neg])).max())
    size = (OUT / "model.onnx").stat().st_size / 1e6
    print(f"labels={labels}  model {size:.0f} MB")
    print(f"label agreement {agree}/{len(SAMPLES)}, max |score diff| {diff:.3f}")
    for h, r, g in zip(SAMPLES, ref, got):
        print(f"  {labels[int(r.argmax())]:>8} {r[pos]-r[neg]:+.3f} | onnx {labels[int(g.argmax())]:>8} {g[pos]-g[neg]:+.3f}  {h[:60]}")


if __name__ == "__main__":
    main()
