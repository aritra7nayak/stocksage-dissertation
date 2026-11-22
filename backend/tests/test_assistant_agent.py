"""Assistant loop with a scripted fake model (no model server needed):
tool calls are executed and fed back, sources are collected, tool calls
written as text are recovered, and the loop always ends with an answer."""
import asyncio

import pytest

from app.assistant import agent, llm, tools


def test_parse_text_tool_calls_json_and_xml():
    js = 'ok <tool_call>{"name": "price_quote", "arguments": {"company": "TCS"}}</tool_call>'
    xml = "<tool_call><function=stock_overview><parameter=company>\nInfosys\n</parameter></function></tool_call>"
    assert agent.parse_text_tool_calls(js) == [{"name": "price_quote", "arguments": {"company": "TCS"}}]
    assert agent.parse_text_tool_calls(xml) == [{"name": "stock_overview", "arguments": {"company": "Infosys"}}]
    assert agent.parse_text_tool_calls("plain answer") == []


@pytest.fixture
def scripted(monkeypatch):
    """Replace the model with a list of canned replies and record what it was sent."""
    sent = []

    def install(replies):
        it = iter(replies)

        async def fake_chat(messages, tools=None, temperature=None, max_tokens=1024):
            sent.append({"messages": [dict(m) for m in messages], "tools": tools})
            return next(it) | {"_usage": {"prompt_tokens": 10, "completion_tokens": 5}}
        monkeypatch.setattr(llm, "chat", fake_chat)
        return sent

    async def fake_quote(ctx, company):
        return {"symbol": "TCS.NS", "price": 3000.0, "source": "test quotes", "as_of": "2026-11-22"}
    monkeypatch.setitem(tools.TOOLS, "price_quote", tools.Tool(fake_quote, tools.TOOLS["price_quote"].description,
                                                               tools.TOOLS["price_quote"].parameters))
    return install


def test_tool_round_then_answer(scripted):
    sent = scripted([
        {"content": "", "tool_calls": [{"id": "c1", "function": {"name": "price_quote",
                                                                 "arguments": '{"company": "TCS"}'}}]},
        {"content": "TCS is at ₹3,000 (test quotes, 22 Nov)."},
    ])
    out = asyncio.run(agent.answer("TCS price?", [], tools.Ctx(db=None)))
    assert out["answer"].startswith("TCS is at")
    assert out["tool_calls"] == [{"tool": "price_quote", "arguments": {"company": "TCS"}, "ok": True}]
    assert out["sources"] == [{"tool": "price_quote", "source": "test quotes", "as_of": "2026-11-22"}]
    tool_msg = sent[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and '"price": 3000.0' in tool_msg["content"]
    assert out["usage"] == {"prompt_tokens": 20, "completion_tokens": 10}


def test_text_tool_call_is_recovered(scripted):
    scripted([{"content": '<tool_call>{"name": "price_quote", "arguments": {"company": "TCS"}}</tool_call>'},
              {"content": "Done."}])
    out = asyncio.run(agent.answer("TCS?", [], tools.Ctx(db=None)))
    assert out["tool_calls"][0]["tool"] == "price_quote" and out["answer"] == "Done."


def test_loop_is_bounded_and_last_round_has_no_tools(scripted, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "assistant_max_rounds", 2)
    loop_call = {"content": "", "tool_calls": [{"id": "x", "function": {"name": "price_quote",
                                                                        "arguments": {"company": "TCS"}}}]}
    sent = scripted([loop_call, loop_call, {"content": "Final."}])
    out = asyncio.run(agent.answer("again and again", [], tools.Ctx(db=None)))
    assert out["answer"] == "Final." and len(sent) == 3 and sent[-1]["tools"] is None


def test_unknown_tool_is_reported_not_raised(scripted):
    scripted([{"content": "", "tool_calls": [{"id": "z", "function": {"name": "teleport", "arguments": "{}"}}]},
              {"content": "I could not find that."}])
    out = asyncio.run(agent.answer("?", [], tools.Ctx(db=None)))
    assert out["tool_calls"][0]["ok"] is False and "unknown tool" in out["tool_calls"][0]["error"]
