"""The assistant's reasoning loop.

question -> model chooses tools -> tools run on the app's data -> results go
back to the model -> ... (at most assistant_max_rounds) -> grounded answer.

The answer carries the tool calls made and the sources they reported, so the
UI (and E5) can check that every number came from a tool.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from app.assistant import llm, tools
from app.config import get_settings

SYSTEM = """You are StockSage, an assistant for the Indian stock market (NSE/BSE), built into the StockSage app.
Today is {today} (IST).

How to answer:
- For ANY number about a stock, index, option, sector, news or the user's portfolio, call a tool first. Never invent prices, ratios, levels or dates.
- For concepts (what is IV, how does a spread work, what does a StockSage screen mean), call knowledge_search.
- Use only facts returned by tools. If a tool returns an error or lacks the data, say so plainly.
- Be concise and structured: a one-line answer, then the key numbers as short bullets, then risks or caveats.
- Mention where numbers come from and how fresh they are (the tool's source and as_of).
- You cannot predict future prices. You may describe trend, levels, valuation, sentiment and the option market's expected range.
- Give analysis, not instructions to trade; StockSage is a research tool, not investment advice. Keep that note to one short line, only when the user asks what to buy or sell.
- Indian conventions: rupees (₹), lakh/crore, NSE tickers like HDFCBANK."""

_JSON_CALL = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)
_XML_CALL = re.compile(r"<function=([\w_]+)>(.*?)</function>", re.S)
_XML_PARAM = re.compile(r"<parameter=([\w_]+)>\s*(.*?)\s*</parameter>", re.S)


def parse_text_tool_calls(content: str) -> list[dict]:
    """Tool calls a small model wrote as text instead of structured tool_calls.

    Handles Qwen's JSON form  <tool_call>{"name": .., "arguments": {..}}</tool_call>
    and its XML form          <function=name><parameter=x>v</parameter></function>."""
    calls = []
    for m in _JSON_CALL.finditer(content or ""):
        try:
            obj = json.loads(m.group(1))
            calls.append({"name": obj.get("name"), "arguments": obj.get("arguments") or {}})
        except json.JSONDecodeError:
            continue
    for m in _XML_CALL.finditer(content or ""):
        args = {}
        for p, v in _XML_PARAM.findall(m.group(2)):
            try:
                args[p] = json.loads(v)
            except json.JSONDecodeError:
                args[p] = v
        calls.append({"name": m.group(1), "arguments": args})
    return calls


def _strip_calls(content: str) -> str:
    text = _JSON_CALL.sub("", content or "")
    text = re.sub(r"<tool_call>.*?</tool_call>", "", text, flags=re.S)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    return text.strip()


async def answer(question: str, history: list[dict] | None, ctx: tools.Ctx) -> dict:
    s = get_settings()
    t0 = time.perf_counter()
    today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%A %d %B %Y, %H:%M")
    messages = [{"role": "system", "content": SYSTEM.format(today=today)}]
    for m in (history or [])[-6:]:                     # short memory keeps the context small
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:2000]})
    messages.append({"role": "user", "content": question})

    trace, sources, usage = [], [], {"prompt_tokens": 0, "completion_tokens": 0}
    schemas = tools.schemas()
    final = None
    for round_no in range(s.assistant_max_rounds + 1):
        last_round = round_no == s.assistant_max_rounds
        msg = await llm.chat(messages, tools=None if last_round else schemas)
        for k in usage:
            usage[k] += msg.get("_usage", {}).get(k, 0) or 0
        calls = [{"id": c.get("id") or f"call_{round_no}_{i}", "name": c["function"]["name"],
                  "arguments": _args(c["function"].get("arguments"))}
                 for i, c in enumerate(msg.get("tool_calls") or [])]
        if not calls and not last_round:
            calls = [{"id": f"text_{round_no}_{i}", **c} for i, c in enumerate(parse_text_tool_calls(msg.get("content")))]
        if not calls:
            final = _strip_calls(msg.get("content") or "")
            break
        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         "tool_calls": [{"id": c["id"], "type": "function",
                                         "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                                        for c in calls]})
        for c in calls:
            result = await tools.call(ctx, c["name"], c["arguments"])
            ok = "error" not in result
            trace.append({"tool": c["name"], "arguments": c["arguments"], "ok": ok,
                          **({} if ok else {"error": result["error"]})})
            if ok and result.get("source"):
                sources.append({"tool": c["name"], "source": result["source"], "as_of": result.get("as_of")})
            messages.append({"role": "tool", "tool_call_id": c["id"], "name": c["name"],
                             "content": json.dumps(result, default=str, ensure_ascii=False)[:6000]})
    return {"answer": final or "I could not complete this answer. Please try rephrasing the question.",
            "tool_calls": trace, "sources": _dedupe(sources), "model": s.assistant_model,
            "rounds": len({t["tool"] for t in trace}), "usage": usage,
            "latency_ms": round((time.perf_counter() - t0) * 1000)}


def _args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        out = json.loads(raw or "{}")
        return out if isinstance(out, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _dedupe(sources: list[dict]) -> list[dict]:
    seen, out = set(), []
    for s in sources:
        key = (s["tool"], s["source"])
        if key not in seen:
            seen.add(key)
            out.append(s)
    return out
