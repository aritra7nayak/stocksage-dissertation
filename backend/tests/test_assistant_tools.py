"""Assistant tools (Module D): the pure trend maths, the tool registry and the
dispatcher's argument checks. Data-backed tools are exercised live, not here."""
import asyncio
import math

from app.assistant import tools


def test_trend_summary_on_a_steady_uptrend():
    closes = [100 * 1.002 ** i for i in range(260)]           # +0.2% a day
    t = tools.trend_summary(closes)
    assert t["trend"] == "uptrend" and t["moving_averages"]["golden_cross"] is True
    assert t["moving_averages"]["price_above"] == {"sma20": True, "sma50": True, "sma200": True}
    assert math.isclose(t["returns_pct"]["1w"], (1.002 ** 5 - 1) * 100, abs_tol=0.1)
    assert t["max_drawdown_pct"] == 0.0 and t["range_52w"]["pct_below_high"] == 0.0
    assert t["support_resistance"]["support_20d"] < t["support_resistance"]["resistance_20d"]


def test_trend_summary_downtrend_drawdown_and_short_history():
    closes = [200 - i * 0.5 for i in range(260)]
    t = tools.trend_summary(closes)
    assert t["trend"] == "downtrend" and t["max_drawdown_pct"] < -60
    assert "error" in tools.trend_summary([100.0] * 10)


def test_every_tool_has_a_valid_schema():
    for name, tool in tools.TOOLS.items():
        p = tool.parameters
        assert p["type"] == "object" and set(p["required"]) <= set(p["properties"]), name
        assert len(tool.description) > 20, name
    names = {s["function"]["name"] for s in tools.schemas()}
    assert names == set(tools.TOOLS)


def test_call_validates_instead_of_raising():
    ctx = tools.Ctx(db=None)
    run = asyncio.run
    assert "unknown tool" in run(tools.call(ctx, "nope", {}))["error"]
    assert "missing arguments" in run(tools.call(ctx, "stock_overview", {}))["error"]
    assert run(tools.call(ctx, "my_portfolio", {}))["error"] == "not signed in"
    # unexpected arguments from the model are dropped, indices resolve without the database
    assert run(tools.call(ctx, "resolve_symbol", {"query": "nifty", "junk": 1})) == {"symbol": "NIFTY", "kind": "index"}
