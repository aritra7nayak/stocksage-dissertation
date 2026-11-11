"""Trades system — the portfolio revamp.

One source of truth per user: the pf_trades table. Populated by Excel import
(idempotent — re-uploads never duplicate) or by in-app add/sell. Everything
derived (holdings, weighted averages, lowest-cost open lot) is computed from
discrete LOTS via deterministic FIFO replay, and can be exported back to an
Excel that mirrors the user's own format.

Import format (learned from the user's real file — sheets '23.24'/'Sheet1'):
one row = one BUY lot [COMP, @, Qty, BUY, Cost, Rate, DATE, Broker, %] with an
optional SELL block on the same row [DATE, Qty, @, Amount]. Sell qty may
exceed that row's lot (the user's own file does this) — FIFO replay resolves
it across lots. Summary/junk rows are skipped with reasons. Extra columns
(Profit, ST, Days…) are preserved in extras for round-tripping.

Name policy (user-typed names like MINERA/MINREA vs ADAPOR/ADAPOW):
exact-normalized matches merge automatically; look-alikes are only SUGGESTED
in the import report — the user confirms merges explicitly (POST /merge).
Confirmed merges persist via pf_aliases so future imports auto-route.

Sell semantics: FIFO by buy date (stated assumption). A row-level sell may
target one specific lot (target_lot_id) — targeted consumption happens first,
any overflow falls back to FIFO. Replay is recomputed per stock after every
mutation, so incremental imports and manual trades stay consistent.
"""
import asyncio
import difflib
import hashlib
import io
import json
import logging
import math
import re
import uuid
from collections import defaultdict
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import select, text, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_router import CurrentUser, get_current_user
from app.db.database import get_db
from app.db.models import StockUniverse
from app.market_data import fetcher

logger = logging.getLogger("stocksage.trades")
router = APIRouter(prefix="/api/trades", tags=["trades"])

EQUITY_SHEETS = ("23.24", "Sheet1")   # asset sheets we import (MF/RBIGB are other asset classes)


# ═══════════════════════ PURE: parsing & normalization ══════════════════════

def norm_name(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())


JUNK_PATTERNS = re.compile(
    r"^(COMP|TOTAL|INVESTED|PURCHASE COST|IN \d|RBI BOND|SGBT ?\d)", re.IGNORECASE)


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def _finite(v):
    """float(v) unless it is None/NaN/inf. Yahoo hands back NaN closes for
    symbols it has no bar for; NaN is truthy, so an unguarded `if price:` lets
    it through and every derived number (and the JSON totals) turns to null."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return None


def base_hash(side: str, norm: str, d: date, qty: float, price: float) -> str:
    key = f"{side}|{norm}|{d.isoformat()}|{qty:.4f}|{price:.4f}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]


SKIP_ROW_MARKERS = ("TOTAL SALE", "PRESENT HOLDING", "(A)")


def _header_map(ws, hr: int) -> dict | None:
    """Map v3 columns strictly by header NAMES (layout-independent).
    Buy block: COMP, Full Form, Head, @, Qty, Purch Amt, Amt+Brock,
    Rate/Eff Rate, Purch Date, Broker, %.  Sell block: Sale Date, @, Qty,
    Sale Amt, Sale-Brcok, NSDL Ch, Profit, % Profit, Days, XIM %,
    Total Brock, % T Brock."""
    names = {}
    order = []
    for c in range(1, ws.max_column + 1):
        v = str(ws.cell(row=hr, column=c).value or "").strip().upper()
        if v:
            order.append((v, c))
            names.setdefault(v, []).append(c)
    if "COMP" not in names or "FULL FORM" not in names:
        return None
    def first(*keys):
        for k in keys:
            if k in names:
                return names[k][0]
        return None
    def nth(key, i):
        return names[key][i] if key in names and len(names[key]) > i else None
    cols = {
        "comp": first("COMP"), "full": first("FULL FORM"), "head": first("HEAD"),
        "bprice": nth("@", 0), "bqty": nth("QTY", 0),
        "bgross": first("PURCH AMT"), "bcost": first("AMT+BROCK"),
        "brate": first("RATE", "EFF RATE"), "bdate": first("PURCH DATE"),
        "bbroker": first("BROKER"), "bbrokpct": nth("%", 0),
        "sdate": first("SALE DATE"), "sprice": nth("@", 1), "sqty": nth("QTY", 1),
        "sgross": first("SALE AMT"), "snet": first("SALE-BRCOK", "SALE-BROCK"),
        "nsdl": first("NSDL CH"), "profit": first("PROFIT"),
        "profitpct": first("% PROFIT"), "days": first("DAYS"),
        "xim": first("XIM %"), "tbrock": first("TOTAL BROCK"),
        "tbrockpct": first("% T BROCK"),
    }
    if not (cols["bprice"] and cols["bqty"] and cols["bdate"]):
        return None
    return cols


def list_candidate_sheets(content: bytes) -> list[dict]:
    """Sheets containing the v3 header (COMP + Full Form), with quick stats."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    out = []
    for name in wb.sheetnames:
        ws = wb[name]
        for hr in range(1, min(6, ws.max_row) + 1):
            vals = [str(ws.cell(row=hr, column=c).value or "").strip().upper()
                    for c in range(1, min(ws.max_column or 1, 30) + 1)]
            if "COMP" in vals and "FULL FORM" in vals:
                out.append({"name": name, "header_row": hr})
                break
    wb.close()
    return out


def parse_workbook(content: bytes, sheet: str) -> dict:
    """Parse ONE v3 sheet → buys, sells, skipped. Each row is a BUY (a lot);
    a filled sale block on the row adds a SELL. Head = portfolio name
    (may be blank → user assigns at import). Summary/legend rows skipped."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    if sheet not in wb.sheetnames:
        raise ValueError(f"Sheet '{sheet}' not found")
    ws = wb[sheet]
    cols = None
    hr = None
    for r in range(1, min(6, ws.max_row) + 1):
        cols = _header_map(ws, r)
        if cols:
            hr = r
            break
    if not cols:
        raise ValueError(f"Sheet '{sheet}' doesn't have the expected COMP/Full Form header")

    def cv(r, key):
        c = cols.get(key)
        return ws.cell(row=r, column=c).value if c else None

    buys, sells, skipped = [], [], []
    for r in range(hr + 1, ws.max_row + 1):
        raw = cv(r, "comp")
        if raw is None or not str(raw).strip():
            continue
        raw = str(raw).strip()
        up = raw.upper()
        if up == "COMP" or any(up.startswith(m) for m in SKIP_ROW_MARKERS):
            continue
        if JUNK_PATTERNS.match(raw):
            skipped.append({"sheet": sheet, "row": r, "name": raw,
                            "reason": "Non-equity row (bond/summary)"})
            continue
        b_price = _num(cv(r, "bprice")); b_qty = _num(cv(r, "bqty"))
        b_date = _date(cv(r, "bdate"))
        if not (b_price and b_price > 0 and b_qty and b_qty > 0 and b_date):
            skipped.append({"sheet": sheet, "row": r, "name": raw,
                            "reason": "Missing/invalid qty, price or date in buy block"})
            continue
        full = str(cv(r, "full") or "").strip() or None
        head = str(cv(r, "head") or "").strip() or None
        n = norm_name(raw)
        b_gross = _num(cv(r, "bgross")) or round(b_qty * b_price, 2)
        buys.append({"raw_name": raw, "norm": n, "full_form": full, "head": head,
                     "date": b_date, "qty": b_qty, "price": b_price, "gross": b_gross,
                     "cost": _num(cv(r, "bcost")), "brokerage": _num(cv(r, "bbroker")),
                     "extras": {"Rate": _num(cv(r, "brate")), "BrokerPct": _num(cv(r, "bbrokpct")),
                                "_sheet": sheet},
                     "sheet": sheet, "row": r})
        s_date = _date(cv(r, "sdate")); s_qty = _num(cv(r, "sqty")); s_price = _num(cv(r, "sprice"))
        if s_date and s_qty and s_qty > 0 and s_price and s_price > 0:
            ratio = s_price / b_price
            if not (0.05 <= ratio <= 20):
                skipped.append({"sheet": sheet, "row": r, "name": raw,
                                "reason": f"Sale price {ratio:,.0f}x the buy price — looks wrong, sale skipped"})
            else:
                sells.append({"raw_name": raw, "norm": n, "full_form": full, "head": head,
                              "date": s_date, "qty": s_qty, "price": s_price,
                              "gross": _num(cv(r, "sgross")) or round(s_qty * s_price, 2),
                              "extras": {"_sheet": sheet,
                                         "SaleNet": _num(cv(r, "snet")),
                                         "NSDLCh": _num(cv(r, "nsdl")),
                                         "Profit": _num(cv(r, "profit")),
                                         "ProfitPct": _num(cv(r, "profitpct")),
                                         "Days": _num(cv(r, "days")),
                                         "XIMPct": _num(cv(r, "xim")),
                                         "TotalBrock": _num(cv(r, "tbrock")),
                                         "TBrockPct": _num(cv(r, "tbrockpct"))},
                              "sheet": sheet, "row": r})
        elif s_date or s_qty or s_price:
            skipped.append({"sheet": sheet, "row": r, "name": raw,
                            "reason": "Partial sale block — buy imported, sale skipped"})

    for coll, side in ((buys, "BUY"), (sells, "SELL")):
        seen: dict[str, int] = defaultdict(int)
        for t in coll:
            h = base_hash(side, t["norm"], t["date"], t["qty"], t["price"])
            seen[h] += 1
            t["dedup_hash"] = f"{h}#{seen[h]}"
    return {"buys": buys, "sells": sells, "skipped": skipped}


# ═══════════════════════ PURE: FIFO lot replay ═══════════════════════════════

def replay_fifo(buys: list[dict], sells: list[dict]) -> tuple[dict, dict, list[str]]:
    """Deterministic lot consumption.

    buys:  [{id, date, qty}]           sells: [{id, date, qty, target_lot_id}]
    Returns (remaining {buy_id: qty_left}, consumption {sell_id: [(buy_id, qty)]},
    warnings). Targeted sells consume their lot first, overflow goes FIFO.
    """
    buys_sorted = sorted(buys, key=lambda b: (b["date"], b["id"]))
    remaining = {b["id"]: float(b["qty"]) for b in buys_sorted}
    consumption: dict = {}
    warnings: list[str] = []

    for s in sorted(sells, key=lambda x: (x["date"], x["id"])):
        need = float(s["qty"])
        eaten = []
        tgt = s.get("target_lot_id")
        if tgt and remaining.get(tgt, 0) > 0:
            take = min(need, remaining[tgt])
            remaining[tgt] -= take
            eaten.append((tgt, take))
            need -= take
        for b in buys_sorted:
            if need <= 1e-9:
                break
            r = remaining[b["id"]]
            if r <= 1e-9:
                continue
            take = min(need, r)
            remaining[b["id"]] -= take
            eaten.append((b["id"], take))
            need -= take
        if need > 1e-9:
            warnings.append(f"Sell of {s['qty']:g} on {s['date']} exceeds shares held "
                            f"by {need:g} — recorded, but {need:g} could not be matched to any lot")
        consumption[s["id"]] = eaten
    return remaining, consumption, warnings


# ═══════════════════════ DB helpers ══════════════════════════════════════════

def _auto_symbol_from_fullname(full_name: str | None, prepared: list) -> str | None:
    """High-confidence symbol from the file's own company name (parentheticals
    stripped). Only >= 0.9 similarity auto-applies; everything else goes to
    the mapping modal for the user."""
    if not full_name or not prepared:
        return None
    clean = re.sub(r"\(.*?\)", " ", full_name)
    fn = norm_name(clean)
    if len(fn) < 4:
        return None
    best, best_score = None, 0.0
    for sym, company, root, comp_norm, words, ini_all, ini_core in prepared:
        if not comp_norm:
            continue
        s = difflib.SequenceMatcher(None, fn, comp_norm).ratio()
        if fn == comp_norm:
            s = 1.0
        elif comp_norm.startswith(fn) or fn.startswith(comp_norm):
            s = max(s, 0.93)
        if s > best_score:
            best, best_score = sym, s
    return best if best_score >= 0.9 else None


async def _resolve_stock(db: AsyncSession, user_id: int, raw_name: str,
                         universe: dict | None = None,
                         full_name: str | None = None,
                         prepared_catalog: list | None = None) -> tuple[int, bool, str | None]:
    """raw name → stock_id. Returns (stock_id, created, resolved_symbol).
    Exact alias/norm match only — look-alike merging is user-confirmed."""
    n = norm_name(raw_name)
    row = (await db.execute(text(
        "SELECT stock_id FROM pf_aliases WHERE user_id=:u AND raw_norm=:n"),
        {"u": user_id, "n": n})).first()
    if row:
        if full_name:
            await db.execute(text(
                "UPDATE pf_stocks SET full_name=COALESCE(full_name, :f) WHERE id=:i"),
                {"f": full_name, "i": row[0]})
        return row[0], False, None
    row = (await db.execute(text(
        "SELECT id FROM pf_stocks WHERE user_id=:u AND norm_key=:n"),
        {"u": user_id, "n": n})).first()
    if row:
        await db.execute(text(
            "INSERT INTO pf_aliases (user_id, raw_norm, stock_id) VALUES (:u,:n,:s) "
            "ON CONFLICT DO NOTHING"), {"u": user_id, "n": n, "s": row[0]})
        return row[0], False, None

    # New stock — resolve symbol: exact ticker, else confident full-name match
    symbol = None
    if universe is not None:
        symbol = universe.get(n)
    if symbol is None and full_name:
        symbol = _auto_symbol_from_fullname(full_name, prepared_catalog or [])
    sid = (await db.execute(text(
        "INSERT INTO pf_stocks (user_id, display_name, norm_key, symbol, full_name) "
        "VALUES (:u,:d,:n,:sym,:f) RETURNING id"),
        {"u": user_id, "d": raw_name, "n": n, "sym": symbol, "f": full_name})).scalar_one()
    await db.execute(text(
        "INSERT INTO pf_aliases (user_id, raw_norm, stock_id) VALUES (:u,:n,:s)"),
        {"u": user_id, "n": n, "s": sid})
    return sid, True, symbol


async def _universe_ticker_map(db: AsyncSession) -> dict:
    rows = (await db.execute(select(StockUniverse.symbol))).scalars().all()
    return {s.replace(".NS", "").upper(): s for s in rows}


async def _replay_stock(db: AsyncSession, user_id: int, portfolio_ref: int | None,
                        stock_id: int) -> list[str]:
    """Recompute qty_remaining for one stock WITHIN one portfolio."""
    rows = (await db.execute(text(
        "SELECT id, side, trade_date, qty, target_lot_id FROM pf_trades "
        "WHERE user_id=:u AND stock_id=:s AND portfolio_ref IS NOT DISTINCT FROM :p"),
        {"u": user_id, "s": stock_id, "p": portfolio_ref})).all()
    buys = [{"id": r[0], "date": r[2], "qty": float(r[3])} for r in rows if r[1] == "BUY"]
    sells = [{"id": r[0], "date": r[2], "qty": float(r[3]), "target_lot_id": r[4]}
             for r in rows if r[1] == "SELL"]
    remaining, _, warnings = replay_fifo(buys, sells)
    for bid, rem in remaining.items():
        await db.execute(text(
            "UPDATE pf_trades SET qty_remaining=:r WHERE id=:i"),
            {"r": round(rem, 4), "i": bid})
    return warnings


def _suggest_merges(new_norms: list[str], existing: list[tuple[int, str, str]]) -> list[dict]:
    """Look-alike suggestions (never auto-applied). existing: (id, display, norm)."""
    out = []
    for n in new_norms:
        for sid, disp, en in existing:
            if en == n:
                continue
            ratio = difflib.SequenceMatcher(None, n, en).ratio()
            if ratio >= 0.8:
                out.append({"name": n, "similar_to": disp, "similar_stock_id": sid,
                            "confidence": round(ratio, 2)})
    return out


# ═══════════════════════ ENDPOINTS ═══════════════════════════════════════════

@router.get("/suggest")
async def suggest(q: str, db: AsyncSession = Depends(get_db),
                  user: CurrentUser = Depends(get_current_user)) -> dict:
    """Autocomplete for the Add-trade form: the user's OWN stock names first
    (keeps naming consistent → no duplicate identities), then NSE universe
    matches (picking one auto-maps the price symbol)."""
    term = (q or "").strip()
    if len(term) < 2:
        return {"results": []}
    like = f"%{term}%"

    own = (await db.execute(text(
        "SELECT id, display_name, symbol FROM pf_stocks "
        "WHERE user_id=:u AND (display_name ILIKE :l OR symbol ILIKE :l) "
        "ORDER BY display_name LIMIT 6"), {"u": user.id, "l": like})).all()
    results = [{"name": r[1], "symbol": r[2], "company": None, "source": "portfolio"}
               for r in own]
    taken_syms = {r[2] for r in own if r[2]}
    taken_names = {norm_name(r[1]) for r in own}

    uni = (await db.execute(
        select(StockUniverse)
        .where(StockUniverse.is_active.is_(True))
        .where((StockUniverse.symbol.ilike(like)) | (StockUniverse.company_name.ilike(like)))
        .limit(8))).scalars().all()
    for u in uni:
        root = u.symbol.replace(".NS", "")
        if u.symbol in taken_syms or norm_name(root) in taken_names:
            continue
        results.append({"name": root, "symbol": u.symbol,
                        "company": u.company_name, "source": "nse"})
        if len(results) >= 10:
            break
    return {"results": results}


# Two-phase import: preview (parse + stash) → user tags sections → commit.
_PENDING: dict[str, dict] = {}


def _prune_pending():
    cutoff = datetime.now().timestamp() - 900
    for k in [k for k, v in _PENDING.items() if v["ts"] < cutoff]:
        _PENDING.pop(k, None)


@router.get("/portfolios")
async def list_portfolios(db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(get_current_user)) -> dict:
    rows = (await db.execute(text(
        "SELECT p.id, p.name, p.last_section, COUNT(t.id) "
        "FROM pf_portfolios p LEFT JOIN pf_trades t ON t.portfolio_ref = p.id "
        "WHERE p.user_id=:u GROUP BY p.id, p.name, p.last_section ORDER BY p.id"),
        {"u": user.id})).all()
    return {"portfolios": [{"id": r[0], "name": r[1], "last_section": r[2],
                            "trades": r[3]} for r in rows]}


@router.post("/portfolios")
async def create_portfolio(body: dict, db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(get_current_user)) -> dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Portfolio needs a name")
    try:
        pid = (await db.execute(text(
            "INSERT INTO pf_portfolios (user_id, name) VALUES (:u,:n) RETURNING id"),
            {"u": user.id, "n": name})).scalar_one()
        await db.commit()
    except Exception:
        raise HTTPException(409, f"You already have a portfolio named '{name}'")
    return {"id": pid, "name": name}


@router.post("/import/preview")
async def import_preview(file: UploadFile = File(...), db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)) -> dict:
    """Stage 1: list candidate sheets (v3 header) and, for each, the
    portfolios found in the Head column + count of blank-Head rows. No writes."""
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Please upload an .xlsx file")
    content = await file.read()
    cand = list_candidate_sheets(content)
    if not cand:
        raise HTTPException(400, "No sheet with the COMP / Full Form header found")

    sheets_out = []
    parsed_cache = {}
    for c in cand:
        try:
            p = parse_workbook(content, c["name"])
        except Exception:
            continue
        parsed_cache[c["name"]] = p
        heads: dict[str, int] = {}
        blank = 0
        for t in p["buys"] + p["sells"]:
            if t["head"]:
                heads[t["head"]] = heads.get(t["head"], 0) + 1
            else:
                blank += 1
        sheets_out.append({"name": c["name"], "header_row": c["header_row"],
                           "buys": len(p["buys"]), "sells": len(p["sells"]),
                           "skipped": len(p["skipped"]),
                           "heads": heads, "blank_head_count": blank})
    if not sheets_out:
        raise HTTPException(400, "Found the header but couldn't parse any sheet")

    _prune_pending()
    token = uuid.uuid4().hex
    _PENDING[token] = {"user_id": user.id, "parsed": parsed_cache,
                       "ts": datetime.now().timestamp()}
    pfs = (await db.execute(text(
        "SELECT id, name FROM pf_portfolios WHERE user_id=:u ORDER BY id"),
        {"u": user.id})).all()
    default = "23.24" if any(s["name"] == "23.24" for s in sheets_out) else sheets_out[0]["name"]
    return {"token": token, "sheets": sheets_out, "default_sheet": default,
            "portfolios": [{"id": r[0], "name": r[1]} for r in pfs]}


@router.post("/import/commit")
async def import_commit(body: dict, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)) -> dict:
    """Stage 2: import the chosen sheet. Portfolios come straight from the
    Head column (matched case-insensitively, created when new). Rows with a
    blank Head go to the portfolio the user picked (blank_head:
    {portfolio_id} or {new_name}) — required only when blanks exist."""
    token = body.get("token")
    pend = _PENDING.get(token or "")
    if not pend or pend["user_id"] != user.id:
        raise HTTPException(410, "Upload expired (or backend restarted) — please re-upload the file")
    sheet = body.get("sheet")
    p = pend["parsed"].get(sheet)
    if not p:
        raise HTTPException(400, f"Sheet '{sheet}' wasn't in the preview")

    blank_count = sum(1 for t in p["buys"] + p["sells"] if not t["head"])
    blank_choice = body.get("blank_head") or {}
    if blank_count and not (blank_choice.get("portfolio_id") or (blank_choice.get("new_name") or "").strip()):
        raise HTTPException(400, f"{blank_count} rows have an empty Head — pick a portfolio for them")

    # portfolio resolver (case-insensitive by name; creates when missing)
    pf_rows = (await db.execute(text(
        "SELECT id, name FROM pf_portfolios WHERE user_id=:u"), {"u": user.id})).all()
    by_lower = {r[1].strip().lower(): r[0] for r in pf_rows}
    created_portfolios: list[str] = []

    async def pf_for_name(name: str) -> int:
        key = name.strip().lower()
        if key in by_lower:
            return by_lower[key]
        pid = (await db.execute(text(
            "INSERT INTO pf_portfolios (user_id, name) VALUES (:u,:n) RETURNING id"),
            {"u": user.id, "n": name.strip()})).scalar_one()
        by_lower[key] = pid
        created_portfolios.append(name.strip())
        return pid

    blank_pf_id = None
    if blank_count:
        if blank_choice.get("new_name"):
            blank_pf_id = await pf_for_name(str(blank_choice["new_name"]))
        else:
            blank_pf_id = blank_choice.get("portfolio_id")
            if blank_pf_id not in by_lower.values():
                own = (await db.execute(text(
                    "SELECT 1 FROM pf_portfolios WHERE id=:i AND user_id=:u"),
                    {"i": blank_pf_id, "u": user.id})).first()
                if not own:
                    raise HTTPException(404, "That portfolio doesn't exist")

    # stock resolution setup: engine universe + full NSE catalog for auto-mapping
    universe = await _universe_ticker_map(db)
    uni = (await db.execute(
        select(StockUniverse.symbol, StockUniverse.company_name)
        .where(StockUniverse.is_active.is_(True)))).all()
    rows_all = [(r[0], r[1]) for r in uni]
    try:
        cat = (await db.execute(text("SELECT symbol, company_name FROM nse_catalog"))).all()
        seen = {r[0] for r in rows_all}
        rows_all += [(r[0], r[1]) for r in cat if r[0] not in seen]
    except Exception:
        pass
    prepared = await asyncio.to_thread(_prepare_rows, rows_all)

    pre_existing = (await db.execute(text(
        "SELECT id, display_name, norm_key FROM pf_stocks WHERE user_id=:u"),
        {"u": user.id})).all()
    stock_cache: dict[str, int] = {}
    stocks_created, symbols_resolved = [], []

    async def stock_for(t):
        n = t["norm"]
        if n in stock_cache:
            return stock_cache[n]
        sid, created, sym = await _resolve_stock(db, user.id, t["raw_name"], universe,
                                                 t.get("full_form"), prepared)
        stock_cache[n] = sid
        if created:
            stocks_created.append(t["raw_name"])
            if sym:
                symbols_resolved.append({"name": t["raw_name"], "symbol": sym})
        return sid

    # per-(portfolio) dedup, insert, replay
    touched: set[tuple[int, int]] = set()

    async def existing_hashes(pf_id: int, hashes: list[str]) -> set:
        out: set = set()
        for i in range(0, len(hashes), 500):
            chunk = hashes[i:i + 500]
            out.update((await db.execute(text(
                "SELECT dedup_hash FROM pf_trades WHERE user_id=:u AND "
                "portfolio_ref=:p AND dedup_hash = ANY(:h)"),
                {"u": user.id, "p": pf_id, "h": chunk})).scalars().all())
        return out

    # group rows by resolved portfolio first
    grouped: dict[int, dict] = {}
    for t in p["buys"]:
        pf_id = await pf_for_name(t["head"]) if t["head"] else blank_pf_id
        grouped.setdefault(pf_id, {"buys": [], "sells": []})["buys"].append(t)
    for t in p["sells"]:
        pf_id = await pf_for_name(t["head"]) if t["head"] else blank_pf_id
        grouped.setdefault(pf_id, {"buys": [], "sells": []})["sells"].append(t)

    report_rows = []
    for pf_id, g in grouped.items():
        hashes = [t["dedup_hash"] for t in g["buys"] + g["sells"]]
        exist = await existing_hashes(pf_id, hashes)
        nb = ns = dup = 0
        for t in g["buys"]:
            if t["dedup_hash"] in exist:
                dup += 1
                continue
            sid = await stock_for(t)
            await db.execute(text(
                "INSERT INTO pf_trades (user_id, portfolio_ref, stock_id, side, trade_date, "
                "qty, price, gross_value, cost_value, brokerage, source, dedup_hash, extras) "
                "VALUES (:u,:pf,:s,'BUY',:d,:q,:p,:g,:c,:b,'IMPORT',:h, CAST(:e AS jsonb))"),
                {"u": user.id, "pf": pf_id, "s": sid, "d": t["date"], "q": t["qty"],
                 "p": t["price"], "g": t["gross"], "c": t["cost"], "b": t["brokerage"],
                 "h": t["dedup_hash"], "e": json.dumps(t["extras"])})
            nb += 1
            touched.add((pf_id, sid))
        for t in g["sells"]:
            if t["dedup_hash"] in exist:
                dup += 1
                continue
            sid = await stock_for(t)
            await db.execute(text(
                "INSERT INTO pf_trades (user_id, portfolio_ref, stock_id, side, trade_date, "
                "qty, price, gross_value, source, dedup_hash, extras) VALUES "
                "(:u,:pf,:s,'SELL',:d,:q,:p,:g,'IMPORT',:h, CAST(:e AS jsonb))"),
                {"u": user.id, "pf": pf_id, "s": sid, "d": t["date"], "q": t["qty"],
                 "p": t["price"], "g": t["gross"], "h": t["dedup_hash"],
                 "e": json.dumps(t["extras"])})
            ns += 1
            touched.add((pf_id, sid))
        pname = (await db.execute(text("SELECT name FROM pf_portfolios WHERE id=:i"),
                                  {"i": pf_id})).scalar_one()
        report_rows.append({"portfolio": pname, "new_buys": nb, "new_sells": ns,
                            "duplicates_skipped": dup})

    warnings: list[str] = []
    for pf_id, sid in touched:
        warnings += await _replay_stock(db, user.id, pf_id, sid)
    await db.commit()
    _PENDING.pop(token, None)

    new_norms = [norm_name(x) for x in stocks_created]
    merges = _suggest_merges(new_norms, [(r[0], r[1], r[2]) for r in pre_existing])
    unmapped = (await db.execute(text(
        "SELECT COUNT(*) FROM pf_stocks WHERE user_id=:u AND symbol IS NULL"),
        {"u": user.id})).scalar()
    return {"portfolios": report_rows,
            "portfolios_created": created_portfolios,
            "stocks_created": stocks_created,
            "symbols_resolved": symbols_resolved,
            "unmapped_count": unmapped,
            "skipped_rows": p["skipped"][:40], "skipped_total": len(p["skipped"]),
            "merge_suggestions": merges[:20],
            "oversell_warnings": warnings[:20]}


def _quotes_from_history(data: dict) -> dict[str, dict]:
    """{symbol: 5d OHLCV} → {symbol: {price, change_pct}}, skipping empties."""
    quotes: dict[str, dict] = {}
    for sym, df in (data or {}).items():
        if df is None or not len(df):
            continue
        last = _finite(df["Close"].iloc[-1])
        if last is None:
            continue
        prev = _finite(df["Close"].iloc[-2]) if len(df) >= 2 else last
        quotes[sym] = {"price": round(last, 2),
                       "change_pct": round((last / prev - 1) * 100, 2) if prev else 0}
    return quotes


async def _fetch_quotes(symbols: list[str]) -> dict[str, dict]:
    """Network fetch off the event loop. A failure yields {} — the caller
    shows those rows as unpriced rather than failing the whole view."""
    if not symbols:
        return {}
    try:
        data = await asyncio.to_thread(fetcher.batch_history, symbols, "5d")
    except Exception:
        logger.warning("Price fetch failed for %d symbols", len(symbols), exc_info=True)
        return {}
    return _quotes_from_history(data)


@router.get("/portfolio")
async def portfolio(portfolio_id: int | None = None,
                    prices: str = "cached",
                    db: AsyncSession = Depends(get_db),
                    user: CurrentUser = Depends(get_current_user)) -> dict:
    """Aggregate view: one row per (portfolio, stock) with open shares.

    prices="cached" (default) never hits the network — rows land instantly and
    unpriced symbols are listed in totals.pending for the client to request in
    small batches from /quotes. prices="full" restores the old blocking fetch.
    """
    q = ("SELECT s.id, s.display_name, s.symbol, t.id, t.trade_date, t.qty, t.price, "
         "t.qty_remaining, t.cost_value, t.brokerage, t.portfolio_ref, p.name "
         "FROM pf_trades t JOIN pf_stocks s ON s.id = t.stock_id "
         "LEFT JOIN pf_portfolios p ON p.id = t.portfolio_ref "
         "WHERE t.user_id=:u AND t.side='BUY'")
    params: dict = {"u": user.id}
    if portfolio_id is not None:
        q += " AND t.portfolio_ref=:pf"
        params["pf"] = portfolio_id
    rows = (await db.execute(text(q), params)).all()

    per: dict[tuple, dict] = {}
    for sid, name, symbol, tid, d, qty, price, rem, cost, brok, pref, pname in rows:
        rem = float(rem if rem is not None else qty)
        st = per.setdefault((pref, sid), {"stock_id": sid, "name": name, "symbol": symbol,
                                  "portfolio_id": pref, "portfolio_name": pname,
                                  "held": 0.0, "value_open": 0.0, "cost_open": 0.0,
                                  "lots_open": 0, "lowest": None, "total_lots": 0})
        st["total_lots"] += 1
        if rem > 1e-9:
            p = float(price)
            eff = float(cost) / float(qty) if cost and float(qty) else p  # incl. brokerage
            st["held"] += rem
            st["value_open"] += rem * p
            st["cost_open"] += rem * eff
            st["lots_open"] += 1
            if st["lowest"] is None or p < st["lowest"]["price"]:
                st["lowest"] = {"lot_id": tid, "price": p, "qty_remaining": round(rem, 4),
                                "date": str(d)}

    held = [s for s in per.values() if s["held"] > 1e-9]

    # Prices: cache-only by default so the table paints immediately. Whatever
    # is cold comes back as pending and the client fills it in via /quotes.
    symbols = sorted({s["symbol"] for s in held if s["symbol"]})
    if prices == "full":
        quotes = await _fetch_quotes(symbols)
    else:
        quotes = _quotes_from_history(fetcher.cached_history(symbols, "5d"))

    out = []
    for s in held:
        q = quotes.get(s["symbol"] or "")
        avg = s["value_open"] / s["held"] if s["held"] else 0
        avg_eff = s["cost_open"] / s["held"] if s["held"] else 0
        cur = q["price"] if q else None
        priced = cur is not None
        out.append({
            "stock_id": s["stock_id"], "name": s["name"], "symbol": s["symbol"],
            "portfolio_id": s["portfolio_id"], "portfolio_name": s["portfolio_name"],
            "held_qty": round(s["held"], 4),
            "avg_buy": round(avg, 2), "avg_buy_incl_brokerage": round(avg_eff, 2),
            "invested": round(s["value_open"], 2),
            "current_price": cur,
            "day_change_pct": q["change_pct"] if q else None,
            "market_value": round(cur * s["held"], 2) if priced else None,
            "pnl": round((cur - avg) * s["held"], 2) if priced else None,
            "pnl_pct": round((cur / avg - 1) * 100, 2) if priced and avg else None,
            "lots_open": s["lots_open"], "total_lots": s["total_lots"],
            "lowest_lot": s["lowest"],
        })
    out.sort(key=lambda x: -(x["market_value"] or x["invested"]))
    totals = {
        "invested": round(sum(x["invested"] for x in out), 2),
        "market_value": round(sum(x["market_value"] or x["invested"] for x in out), 2),
        "pnl": round(sum(x["pnl"] or 0 for x in out), 2),
        "stocks": len(out),
        "priced": sum(1 for x in out if x["current_price"] is not None),
        "unpriceable": sum(1 for x in out if not x["symbol"]),
    }
    pending = sorted({x["symbol"] for x in out
                      if x["symbol"] and x["current_price"] is None})
    return {"holdings": out, "totals": totals, "pending_symbols": pending}


MAX_QUOTE_BATCH = 40


@router.get("/quotes")
async def quotes(symbols: str,
                 user: CurrentUser = Depends(get_current_user)) -> dict:
    """Live last-price + day-change for a small batch of symbols.

    Deliberately small: the portfolio page walks its unpriced symbols a chunk
    at a time so each response paints rows instead of the user staring at a
    blank page while one giant download finishes. Results are cached by the
    fetcher, so a repeat is free.
    """
    wanted = [s.strip() for s in symbols.split(",") if s.strip()][:MAX_QUOTE_BATCH]
    if not wanted:
        return {"quotes": {}, "missing": []}
    got = await _fetch_quotes(wanted)
    return {"quotes": got, "missing": [s for s in wanted if s not in got]}


@router.get("/stock/{stock_id}")
async def stock_detail(stock_id: int, portfolio_id: int | None = None,
                       db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """Drill-down: every lot (open first) + every sell, plus a live quote."""
    st = (await db.execute(text(
        "SELECT id, display_name, symbol FROM pf_stocks WHERE id=:i AND user_id=:u"),
        {"i": stock_id, "u": user.id})).first()
    if not st:
        raise HTTPException(404, "Stock not found")

    dq = ("SELECT id, side, trade_date, qty, price, gross_value, cost_value, brokerage, "
          "qty_remaining, target_lot_id, source, extras FROM pf_trades "
          "WHERE user_id=:u AND stock_id=:s")
    dparams: dict = {"u": user.id, "s": stock_id}
    if portfolio_id is not None:
        dq += " AND portfolio_ref=:p"
        dparams["p"] = portfolio_id
    dq += " ORDER BY trade_date, id"
    rows = (await db.execute(text(dq), dparams)).all()

    lots, sells_out = [], []
    for r in rows:
        if r[1] == "BUY":
            rem = float(r[8] if r[8] is not None else r[3])
            qty = float(r[3])
            status = "OPEN" if abs(rem - qty) < 1e-9 else ("SOLD" if rem <= 1e-9 else "PARTIAL")
            lots.append({"lot_id": r[0], "date": str(r[2]), "qty": qty, "price": float(r[4]),
                         "gross": float(r[5] or 0), "cost": float(r[6]) if r[6] else None,
                         "brokerage": float(r[7]) if r[7] else None,
                         "qty_remaining": round(rem, 4), "status": status, "source": r[10]})
        else:
            sells_out.append({"trade_id": r[0], "date": str(r[2]), "qty": float(r[3]),
                              "price": float(r[4]), "value": float(r[5] or 0),
                              "target_lot_id": r[9], "source": r[10]})

    quote = None
    if st[2]:
        try:
            df = await asyncio.to_thread(fetcher.get_history, st[2], "5d")
            last = _finite(df["Close"].iloc[-1]) if df is not None and len(df) else None
            if last is not None:
                prev = _finite(df["Close"].iloc[-2]) if len(df) >= 2 else last
                quote = {"price": round(last, 2),
                         "change_pct": round((last / prev - 1) * 100, 2) if prev else 0}
        except Exception:
            pass

    # open/partial first (newest first inside each group), sold last
    order = {"OPEN": 0, "PARTIAL": 0, "SOLD": 1}
    lots.sort(key=lambda l: (order[l["status"]], l["date"]))
    return {"stock_id": st[0], "name": st[1], "symbol": st[2], "quote": quote,
            "lots": lots, "sells": sells_out,
            "held_qty": round(sum(l["qty_remaining"] for l in lots), 4)}


class AddTrade(dict):
    pass


@router.post("/add")
async def add_trade(body: dict, db: AsyncSession = Depends(get_db),
                    user: CurrentUser = Depends(get_current_user)) -> dict:
    """Manual BUY — first-class equal of imported trades."""
    name = (body.get("name") or "").strip()
    qty, price = _num(body.get("qty")), _num(body.get("price"))
    d = body.get("date")
    brokerage = _num(body.get("brokerage")) or 0.0
    if not name or not qty or qty <= 0 or not price or price <= 0:
        raise HTTPException(400, "Need name, qty > 0 and price > 0")
    try:
        d = date.fromisoformat(d) if d else date.today()
    except ValueError:
        raise HTTPException(400, "Date must be YYYY-MM-DD")
    pf_id = body.get("portfolio_id")
    pfs = (await db.execute(text(
        "SELECT id FROM pf_portfolios WHERE user_id=:u ORDER BY id"), {"u": user.id})).scalars().all()
    if pf_id is None:
        if len(pfs) == 0:
            pf_id = (await db.execute(text(
                "INSERT INTO pf_portfolios (user_id, name) VALUES (:u,'Portfolio 1') RETURNING id"),
                {"u": user.id})).scalar_one()
        elif len(pfs) == 1:
            pf_id = pfs[0]
        else:
            raise HTTPException(400, "You have multiple portfolios — pick one")
    elif pf_id not in pfs:
        raise HTTPException(404, "Portfolio not found")
    universe = await _universe_ticker_map(db)
    sid, created, sym = await _resolve_stock(db, user.id, name, universe)
    picked_symbol = (body.get("symbol") or "").strip().upper()
    if picked_symbol:
        if not picked_symbol.endswith(".NS"):
            picked_symbol += ".NS"
        await db.execute(text(
            "UPDATE pf_stocks SET symbol=:s WHERE id=:i AND user_id=:u"),
            {"s": picked_symbol, "i": sid, "u": user.id})
        sym = picked_symbol
    gross = round(qty * price, 2)
    await db.execute(text(
        "INSERT INTO pf_trades (user_id, portfolio_ref, stock_id, side, trade_date, qty, price, "
        "gross_value, cost_value, brokerage, source, dedup_hash) VALUES "
        "(:u,:pf,:s,'BUY',:d,:q,:p,:g,:c,:b,'MANUAL',:h)"),
        {"u": user.id, "pf": pf_id, "s": sid, "d": d, "q": qty, "p": price, "g": gross,
         "c": round(gross + brokerage, 2), "b": brokerage,
         "h": f"MANUAL-{uuid.uuid4().hex[:20]}"})
    await _replay_stock(db, user.id, pf_id, sid)
    await db.commit()
    return {"status": f"Added {qty:g} × {name} @ ₹{price:,.2f}",
            "stock_id": sid, "new_stock": created,
            "symbol_resolved": sym}


@router.post("/sell")
async def sell_generic(body: dict, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """Generic sell: stock + qty + price → FIFO across open lots."""
    stock_id = body.get("stock_id")
    qty, price = _num(body.get("qty")), _num(body.get("price"))
    d = body.get("date")
    if not stock_id or not qty or qty <= 0 or not price or price <= 0:
        raise HTTPException(400, "Need stock_id, qty > 0 and price > 0")
    try:
        d = date.fromisoformat(d) if d else date.today()
    except ValueError:
        raise HTTPException(400, "Date must be YYYY-MM-DD")
    pf_id = body.get("portfolio_id")
    if not pf_id:
        raise HTTPException(400, "portfolio_id is required")
    own = (await db.execute(text(
        "SELECT 1 FROM pf_stocks WHERE id=:i AND user_id=:u"),
        {"i": stock_id, "u": user.id})).first()
    if not own:
        raise HTTPException(404, "Stock not found")
    avail = float((await db.execute(text(
        "SELECT COALESCE(SUM(qty_remaining),0) FROM pf_trades "
        "WHERE user_id=:u AND stock_id=:s AND side='BUY' AND portfolio_ref=:p"),
        {"u": user.id, "s": stock_id, "p": pf_id})).scalar())
    if qty > avail + 1e-9:
        raise HTTPException(400, f"Only {avail:g} shares held — can't sell {qty:g}")
    await db.execute(text(
        "INSERT INTO pf_trades (user_id, portfolio_ref, stock_id, side, trade_date, qty, price, "
        "gross_value, source, dedup_hash) VALUES "
        "(:u,:pf,:s,'SELL',:d,:q,:p,:g,'MANUAL',:h)"),
        {"u": user.id, "pf": pf_id, "s": stock_id, "d": d, "q": qty, "p": price,
         "g": round(qty * price, 2), "h": f"MANUAL-{uuid.uuid4().hex[:20]}"})
    await _replay_stock(db, user.id, pf_id, stock_id)
    await db.commit()
    return {"status": f"Sold {qty:g} @ ₹{price:,.2f} (FIFO across lots)"}


@router.post("/sell-lot")
async def sell_lot(body: dict, db: AsyncSession = Depends(get_db),
                   user: CurrentUser = Depends(get_current_user)) -> dict:
    """Row-level sell against one specific lot. Qty defaults to the lot's remainder."""
    lot_id = body.get("lot_id")
    price = _num(body.get("price"))
    qty = _num(body.get("qty"))
    d = body.get("date")
    if not lot_id or not price or price <= 0:
        raise HTTPException(400, "Need lot_id and price > 0")
    try:
        d = date.fromisoformat(d) if d else date.today()
    except ValueError:
        raise HTTPException(400, "Date must be YYYY-MM-DD")
    lot = (await db.execute(text(
        "SELECT id, stock_id, qty_remaining, portfolio_ref FROM pf_trades "
        "WHERE id=:i AND user_id=:u AND side='BUY'"),
        {"i": lot_id, "u": user.id})).first()
    if not lot:
        raise HTTPException(404, "Lot not found")
    rem = float(lot[2] or 0)
    if rem <= 1e-9:
        raise HTTPException(400, "That lot is already fully sold")
    qty = qty if qty else rem
    if qty > rem + 1e-9:
        raise HTTPException(400, f"Lot has only {rem:g} shares remaining")
    await db.execute(text(
        "INSERT INTO pf_trades (user_id, portfolio_ref, stock_id, side, trade_date, qty, price, "
        "gross_value, target_lot_id, source, dedup_hash) VALUES "
        "(:u,:pf,:s,'SELL',:d,:q,:p,:g,:t,'MANUAL',:h)"),
        {"u": user.id, "pf": lot[3], "s": lot[1], "d": d, "q": qty, "p": price,
         "g": round(qty * price, 2), "t": lot_id, "h": f"MANUAL-{uuid.uuid4().hex[:20]}"})
    await _replay_stock(db, user.id, lot[3], lot[1])
    await db.commit()
    return {"status": f"Sold {qty:g} from this lot @ ₹{price:,.2f}"}


@router.post("/stocks/{stock_id}/merge")
async def merge_stocks(stock_id: int, body: dict, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """User-confirmed merge: move all trades+aliases of `other_stock_id` into this one."""
    other = body.get("other_stock_id")
    a = (await db.execute(text("SELECT id, display_name FROM pf_stocks WHERE id=:i AND user_id=:u"),
                          {"i": stock_id, "u": user.id})).first()
    b = (await db.execute(text("SELECT id, display_name FROM pf_stocks WHERE id=:i AND user_id=:u"),
                          {"i": other, "u": user.id})).first()
    if not a or not b or a[0] == b[0]:
        raise HTTPException(404, "Both stocks must exist and differ")
    await db.execute(text("UPDATE pf_trades SET stock_id=:a WHERE stock_id=:b AND user_id=:u"),
                     {"a": a[0], "b": b[0], "u": user.id})
    await db.execute(text("UPDATE pf_aliases SET stock_id=:a WHERE stock_id=:b AND user_id=:u"),
                     {"a": a[0], "b": b[0], "u": user.id})
    await db.execute(text("DELETE FROM pf_stocks WHERE id=:b AND user_id=:u"),
                     {"b": b[0], "u": user.id})
    prefs = (await db.execute(text(
        "SELECT DISTINCT portfolio_ref FROM pf_trades WHERE user_id=:u AND stock_id=:s"),
        {"u": user.id, "s": a[0]})).scalars().all()
    for pref in prefs:
        await _replay_stock(db, user.id, pref, a[0])
    await db.commit()
    return {"status": f"Merged '{b[1]}' into '{a[1]}' — future imports of either name land here"}


@router.post("/stocks/{stock_id}/symbol")
async def set_symbol(stock_id: int, body: dict, db: AsyncSession = Depends(get_db),
                     user: CurrentUser = Depends(get_current_user)) -> dict:
    """Map/fix the Yahoo symbol for price lookups (e.g. ONE97 → PAYTM.NS)."""
    sym = (body.get("symbol") or "").strip().upper()
    if sym and not sym.endswith(".NS"):
        sym += ".NS"
    r = await db.execute(text(
        "UPDATE pf_stocks SET symbol=:s WHERE id=:i AND user_id=:u RETURNING display_name"),
        {"s": sym or None, "i": stock_id, "u": user.id})
    row = r.first()
    if not row:
        raise HTTPException(404, "Stock not found")
    await db.commit()
    return {"status": f"{row[0]} → {sym or 'no symbol (price lookup off)'}"}


_STOPWORDS = {"OF", "THE", "AND", "LTD", "LIMITED", "&", "CO", "CORP", "CORPORATION"}


def _composes(norm: str, words: list[str]) -> int:
    """Can `norm` be built from in-order PREFIXES of the company's words
    (skipping words allowed)?  ADAPOW = ADA(ni)+POW(er); INTAVI =
    INT(erglobe)+AVI(ation); RAIVIK = RAI(l)+VIK(as). Returns max words used
    (0 = doesn't compose). The single most common way Indians abbreviate."""
    ws = [w for w in words if w and w not in _STOPWORDS]
    n, m = len(norm), len(ws)
    if not n or not m:
        return 0
    best = 0
    memo: dict = {}

    def dp(i: int, j: int, used: int):
        nonlocal best
        if i == n:
            if used >= 1:
                best = max(best, used)
            return
        if j == m or (i, j) in memo and memo[(i, j)] >= used:
            if j == m:
                return
        memo[(i, j)] = used
        dp(i, j + 1, used)                       # skip this word
        w = ws[j]
        k = 1
        while k <= len(w) and i + k <= n and norm[i:i + k] == w[:k]:
            dp(i + k, j + 1, used + 1)           # take prefix of length k
            k += 1

    dp(0, 0, 0)
    return best


def _is_subseq(needle: str, hay: str) -> bool:
    it = iter(hay)
    return all(ch in it for ch in needle)


def _prepare_rows(rows: list) -> list:
    """Precompute per-company fields once so scoring 87 stocks × 2000+
    companies stays fast."""
    prep = []
    for sym, company in rows:
        root = sym.replace(".NS", "").upper()
        comp_norm = norm_name(company or "")
        words = [w for w in re.split(r"[^A-Za-z]+", (company or "").upper()) if w]
        ini_all = "".join(w[0] for w in words if w != "THE")
        ini_core = "".join(w[0] for w in words if w not in ("LTD", "LIMITED", "THE"))
        prep.append((sym, company, root, comp_norm, words, ini_all, ini_core))
    return prep


def _symbol_candidates(norm: str, universe_rows: list) -> list[dict]:
    """Rank Yahoo-symbol candidates for a user-typed stock name using several
    similarity signals: ticker fuzz, company-name fuzz, company INITIALS
    (RIL = Reliance Industries Ltd), word-prefix COMPOSITION (ADAPOW =
    ADAni+POWer), and subsequence containment. Composition is capped below
    the auto-preselect bar because it is genuinely ambiguous (RELII composes
    from both Reliance INdustries and Reliance INfra) — those the user picks."""
    out = []
    for sym, company, root, comp_norm, words, ini_all, ini_core in universe_rows:
        score = difflib.SequenceMatcher(None, norm, root).ratio()
        if comp_norm:
            score = max(score, difflib.SequenceMatcher(
                None, norm, comp_norm[:max(len(norm), 6)]).ratio() * 0.95)
        # initials (with and without Ltd — the L in RIL is Ltd)
        if norm in (ini_all, ini_core) and len(norm) >= 2:
            score = max(score, 0.96)
        elif ini_core and len(norm) >= 2 and (norm.startswith(ini_core) or ini_core.startswith(norm)):
            score = max(score, 0.75)
        # word-prefix composition (capped at 0.89 → shown top, never auto-applied)
        used = _composes(norm, words)
        if used >= 2:
            score = max(score, 0.89)
        elif used == 1 and len(norm) >= 4:
            score = max(score, 0.8)
        # composition against the ticker itself (e.g. norm is a prefix-mash of it)
        if len(norm) >= 3 and root.startswith(norm[:4]):
            score = max(score, 0.8)
        if len(norm) >= 4 and norm in comp_norm:
            score = max(score, 0.85)
        # subsequence: every letter of norm appears in order in the company name
        if len(norm) >= 4 and _is_subseq(norm, comp_norm):
            score = max(score, 0.72)
        if score >= 0.45:
            out.append({"symbol": sym, "company": company, "score": round(score, 2)})
    out.sort(key=lambda x: -x["score"])
    return out[:10]


@router.get("/catalog/status")
async def catalog_status(db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)) -> dict:
    try:
        n = (await db.execute(text("SELECT COUNT(*) FROM nse_catalog"))).scalar()
    except Exception:
        n = -1     # table missing (migration not run)
    return {"count": n}


@router.post("/catalog/refresh")
async def catalog_refresh(db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(get_current_user)) -> dict:
    """Download NSE's official equity list (~2000+ companies) into nse_catalog.
    One-time (re-run any time to pick up new listings)."""
    def fetch():
        import csv
        import io as _io
        import requests
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                   "Accept": "text/csv,*/*"}
        urls = ["https://archives.nseindia.com/content/equities/EQUITY_L.csv",
                "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
                "https://archives.nseindia.com/content/equities/eq_etfseclist.csv",
                "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv"]
        collected, sources = [], []
        for u in urls:
            try:
                r = requests.get(u, headers=headers, timeout=25)
                if r.status_code == 200 and "SYMBOL" in r.text[:300].upper():
                    reader = csv.DictReader(_io.StringIO(r.text))
                    got = 0
                    for row in reader:
                        row = { (k or "").strip().upper(): (v or "").strip()
                                for k, v in row.items() }
                        sym = row.get("SYMBOL")
                        name = (row.get("NAME OF COMPANY") or row.get("NAME OF THE COMPANY")
                                or row.get("SECURITY NAME") or row.get("UNDERLYING"))
                        series = (row.get("SERIES") or "").upper()
                        if sym and series in ("EQ", "BE", "BZ", "SM", "ST", ""):
                            collected.append((f"{sym.upper()}.NS", name))
                            got += 1
                    if got:
                        sources.append(u.rsplit("/", 1)[-1])
            except Exception:
                continue
        return (collected, " + ".join(sources)) if collected else (None, None)

    rows, source = await asyncio.to_thread(fetch)
    if not rows:
        raise HTTPException(502, "Couldn't download NSE's equity list right now — try again in a minute")
    inserted = 0
    for i in range(0, len(rows), 500):
        for sym, name in rows[i:i + 500]:
            await db.execute(text(
                "INSERT INTO nse_catalog (symbol, company_name, updated_at) "
                "VALUES (:s, :n, now()) ON CONFLICT (symbol) DO UPDATE SET "
                "company_name = :n, updated_at = now()"), {"s": sym, "n": name})
            inserted += 1
    await db.commit()
    return {"loaded": inserted, "source": source,
            "status": f"NSE catalog loaded — {inserted:,} companies available for mapping"}


@router.get("/catalog/search")
async def catalog_search(q: str, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)) -> dict:
    """Type-ahead over the FULL catalog (symbol or company name)."""
    term = (q or "").strip()
    if len(term) < 2:
        return {"results": []}
    like = f"%{term}%"
    try:
        rows = (await db.execute(text(
            "SELECT symbol, company_name FROM nse_catalog "
            "WHERE symbol ILIKE :l OR company_name ILIKE :l "
            "ORDER BY (symbol ILIKE :pfx) DESC, symbol LIMIT 12"),
            {"l": like, "pfx": f"{term}%"})).all()
    except Exception:
        rows = []
    return {"results": [{"symbol": r[0], "company": r[1]} for r in rows]}


@router.get("/unmapped-suggestions")
async def unmapped_suggestions(db: AsyncSession = Depends(get_db),
                               user: CurrentUser = Depends(get_current_user)) -> dict:
    """Every stock without a price symbol, each with up to 10 ranked candidates.
    Top candidate is pre-selected in the UI when confident (>= 0.8) — the user
    always confirms before anything is applied."""
    stocks = (await db.execute(text(
        "SELECT DISTINCT s.id, s.display_name, s.norm_key FROM pf_stocks s "
        "JOIN pf_trades t ON t.stock_id = s.id "
        "WHERE s.user_id=:u AND s.symbol IS NULL ORDER BY s.display_name"),
        {"u": user.id})).all()
    uni = (await db.execute(
        select(StockUniverse.symbol, StockUniverse.company_name)
        .where(StockUniverse.is_active.is_(True)))).all()
    seen_syms = {r[0] for r in uni}
    rows_all = [(r[0], r[1]) for r in uni]
    try:
        cat = (await db.execute(text(
            "SELECT symbol, company_name FROM nse_catalog"))).all()
        rows_all += [(r[0], r[1]) for r in cat if r[0] not in seen_syms]
    except Exception:
        pass    # catalog table not created yet — universe-only
    prepared = await asyncio.to_thread(_prepare_rows, rows_all)
    items = []
    for sid, disp, nk in stocks:
        cands = _symbol_candidates(nk, prepared)
        items.append({"stock_id": sid, "name": disp, "candidates": cands,
                      "preselect": cands[0]["symbol"] if cands and cands[0]["score"] >= 0.9 else None})
    return {"unmapped": items}


@router.post("/apply-symbols")
async def apply_symbols(body: dict, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)) -> dict:
    """Bulk-apply user-confirmed symbol mappings: [{stock_id, symbol}]."""
    applied = 0
    for m in (body.get("mappings") or []):
        sym = (m.get("symbol") or "").strip().upper()
        sid = m.get("stock_id")
        if not sym or not sid:
            continue
        if not sym.endswith(".NS"):
            sym += ".NS"
        r = await db.execute(text(
            "UPDATE pf_stocks SET symbol=:s WHERE id=:i AND user_id=:u"),
            {"s": sym, "i": sid, "u": user.id})
        if r.rowcount:
            applied += 1
    await db.commit()
    return {"applied": applied, "status": f"Linked {applied} stock(s) to live prices"}


@router.get("/export")
async def export_excel(db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)):
    """Download in the user's exact v3 layout, sheet '23.24':
    sold rows (buy+sale on one row, all derived cols) → blank →
    'TOTAL SALE at a GLANCE' sums → blank → bought rows (open lots,
    cols 1-11, Head always written) → 'Present Holding at a Glance' totals →
    header repeat ('Eff Rate') → column-letter legend.

    Derived formulas (verified against the user's own BHEL row):
      SaleBroker = SaleAmt − SaleNet;  Profit = SaleNet − Cost − NSDL;
      %Profit = Profit/Cost×100;  Days = sale−purch;
      XIM% = %Profit×365/(Days+1);  TotalBrock = buyBroker+saleBroker+NSDL;
      %TBrock = TotalBrock/SaleAmt×100."""
    import openpyxl
    from openpyxl.styles import Font

    rows = (await db.execute(text(
        "SELECT t.id, s.display_name, s.full_name, t.side, t.trade_date, t.qty, t.price, "
        "t.gross_value, t.cost_value, t.brokerage, t.qty_remaining, t.target_lot_id, "
        "t.extras, t.stock_id, t.portfolio_ref, COALESCE(p.name,'') "
        "FROM pf_trades t JOIN pf_stocks s ON s.id=t.stock_id "
        "LEFT JOIN pf_portfolios p ON p.id=t.portfolio_ref "
        "WHERE t.user_id=:u ORDER BY s.display_name, t.trade_date, t.id"),
        {"u": user.id})).all()

    # replay per (portfolio, stock) → consumption map for weighted buy-side of sells
    groups: dict = defaultdict(lambda: {"buys": [], "sells": []})
    by_id: dict = {}
    for r in rows:
        by_id[r[0]] = r
        rec = {"id": r[0], "date": r[4], "qty": float(r[5]), "target_lot_id": r[11]}
        groups[(r[14], r[13])]["buys" if r[3] == "BUY" else "sells"].append(rec)
    consumption: dict[int, list] = {}
    for key, g in groups.items():
        _, cons, _ = replay_fifo(g["buys"], g["sells"])
        consumption.update(cons)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "23.24"
    HDR = ["COMP", "Full Form", "Head", "@", "Qty", "Purch Amt", "Amt+Brock", "Rate",
           "Purch Date", "Broker", "%", "", "Sale Date", "@", "Qty", "Sale Amt",
           "Sale-Brcok", "NSDL Ch", "Profit", "% Profit", "Days", "XIM %",
           "Total Brock", "% T Brock"]
    ws.append(HDR)
    for c in range(1, len(HDR) + 1):
        ws.cell(row=1, column=c).font = Font(bold=True)
    line = 2

    # ── sold rows ──
    sells = sorted([r for r in rows if r[3] == "SELL"], key=lambda r: (r[4], r[0]))
    sums = defaultdict(float)
    for r in sells:
        ex = r[12] or {}
        s_qty, s_price = float(r[5]), float(r[6])
        s_amt = float(r[7] or s_qty * s_price)
        eaten = consumption.get(r[0], [])
        b_amt = b_cost = b_broker = 0.0
        b_date = None
        for lot_id, take in eaten:
            lot = by_id.get(lot_id)
            if not lot:
                continue
            lqty = float(lot[5]) or 1.0
            frac = take / lqty
            b_amt += take * float(lot[6])
            b_cost += frac * float(lot[8] or lot[7] or take * float(lot[6]))
            b_broker += frac * float(lot[9] or 0)
            if b_date is None or lot[4] < b_date:
                b_date = lot[4]
        if b_date is None:
            b_date = r[4]
        rate = b_cost / s_qty if s_qty else None
        s_net = ex.get("SaleNet")
        nsdl = ex.get("NSDLCh")
        if s_net is None:
            s_net = s_amt
        if nsdl is None:
            nsdl = 0.0
        sale_broker = s_amt - float(s_net)
        profit = ex.get("Profit")
        if profit is None:
            profit = float(s_net) - b_cost - float(nsdl)
        ppct = ex.get("ProfitPct")
        if ppct is None:
            ppct = (profit / b_cost * 100) if b_cost else 0.0
        days = ex.get("Days")
        if days is None:
            days = (r[4] - b_date).days
        xim = ex.get("XIMPct")
        if xim is None:
            xim = ppct * 365 / (days + 1) if days is not None else None
        tbrock = ex.get("TotalBrock")
        if tbrock is None:
            tbrock = b_broker + sale_broker + float(nsdl)
        tbpct = ex.get("TBrockPct")
        if tbpct is None:
            tbpct = (tbrock / s_amt * 100) if s_amt else 0.0
        bpct = (b_broker / b_amt * 100) if b_amt else None

        vals = [r[1], r[2], r[15] or "", round(b_amt / s_qty, 4) if s_qty else None, s_qty,
                round(b_amt, 2), round(b_cost, 2), round(rate, 6) if rate else None,
                b_date, round(b_broker, 2), bpct, "",
                r[4], s_price, s_qty, round(s_amt, 2), round(float(s_net), 2),
                round(float(nsdl), 2), round(float(profit), 4), ppct, days, xim,
                round(float(tbrock), 4), tbpct]
        ws.append(vals)
        line += 1
        for k, v in (("PurchAmt", b_amt), ("Cost", b_cost), ("Broker", b_broker),
                     ("SaleAmt", s_amt), ("SaleNet", float(s_net)), ("NSDL", float(nsdl)),
                     ("Profit", float(profit)), ("TBrock", float(tbrock))):
            sums[k] += v

    # blank + TOTAL SALE at a GLANCE
    ws.append([])
    line += 1
    if sells:
        tot = ["TOTAL SALE at a GLANCE", "", "", "", "",
               round(sums["PurchAmt"], 2), round(sums["Cost"], 2), "", "",
               round(sums["Broker"], 2),
               (sums["Broker"] / sums["PurchAmt"] * 100) if sums["PurchAmt"] else None, "",
               "", "", "", round(sums["SaleAmt"], 2), round(sums["SaleNet"], 2),
               round(sums["NSDL"], 2), round(sums["Profit"], 4),
               (sums["Profit"] / sums["Cost"] * 100) if sums["Cost"] else None, "", "",
               round(sums["TBrock"], 4),
               (sums["TBrock"] / sums["SaleAmt"] * 100) if sums["SaleAmt"] else None]
        ws.append(tot)
        ws.cell(row=line, column=1).font = Font(bold=True)
        line += 1
    ws.append([])
    line += 1

    # ── bought rows: open lots (qty_remaining), Head ALWAYS written ──
    open_lots = [r for r in rows if r[3] == "BUY" and float(r[10] if r[10] is not None else r[5]) > 1e-9]
    open_lots.sort(key=lambda r: (r[1], r[4], r[0]))
    hsum = defaultdict(float)
    for r in open_lots:
        ex = r[12] or {}
        qty = float(r[5])
        rem = float(r[10] if r[10] is not None else qty)
        frac = rem / qty if qty else 1.0
        price = float(r[6])
        amt = rem * price
        cost = frac * float(r[8] or r[7] or amt)
        broker = frac * float(r[9] or 0)
        ws.append([r[1], r[2], r[15] or "", price, rem, round(amt, 2), round(cost, 2),
                   round(cost / rem, 6) if rem else None, r[4], round(broker, 2),
                   (broker / amt * 100) if amt else None])
        line += 1
        hsum["Amt"] += amt
        hsum["Cost"] += cost
        hsum["Broker"] += broker

    ws.append(["Present Holding at a Glance", "", "", "", "",
               round(hsum["Amt"], 2), round(hsum["Cost"], 2), "", "",
               round(hsum["Broker"], 2),
               (hsum["Broker"] / hsum["Amt"] * 100) if hsum["Amt"] else None])
    ws.cell(row=line, column=1).font = Font(bold=True)
    line += 1
    hdr2 = ["COMP", "Full Form", "Head", "@", "Qty", "Purch Amt", "Amt+Brock",
            "Eff Rate", "Purch Date", "Broker", "%"]
    ws.append(hdr2)
    for c in range(1, len(hdr2) + 1):
        ws.cell(row=line, column=c).font = Font(bold=True)
    line += 1
    ws.append(["(A)", "(B)", "C", "D", "E", "F", "G", "H", "K", "L", "(J)"])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"CF1_Share_Software_{date.today().strftime('%d_%m_%y')}.xlsx"
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'})
