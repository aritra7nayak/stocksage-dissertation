"""Research tab: label the dissertation corpus in the browser.

Annotator A labels the whole sample (data/corpus/sample.jsonl). Annotator B
labels only the double-annotated subset and never sees A's labels.

Guidelines v1.2: every row, for both annotators, starts from the LLM
pre-label (data/annotation/prelabels.jsonl), all six fields. Saving a row is
the review: the pre-label that was shown is stored with the label, and import
marks the row human_verified. Because both annotators review the same
pre-label, kappa on the double subset is pre-label-assisted agreement; the
write-up reports it as such, together with each annotator's change rate.

Labels live in the `annotations` table and are exported for training with
    python -m research.build_sample import-db --annotator A --to data/annotation/annotator_a.jsonl
This module does not import research/ (the API never does); the label values
below mirror research/schema.py and a test keeps them equal.
"""
import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_router import CurrentUser, get_current_user
from app.config import get_settings
from app.db.database import get_db

router = APIRouter(prefix="/api/research", tags=["research"])

SENTIMENTS = ("negative", "neutral", "positive")
EVENT_TYPES = ("regulatory_action", "fraud_default", "monetary_policy", "earnings_guidance",
               "corporate_action", "macro_geopolitical", "flows", "other")
SEVERITIES = ("none", "low", "medium", "high")
SCOPES = ("market", "sector", "company", "none")
SECTORS = ("IT", "Banking & Finance", "Pharma & Healthcare", "Oil & Gas", "Metal",
           "Energy & Power", "Manufacturing", "FMCG", "Services")
PRELABEL_FIELDS = ("sentiment", "events", "severity", "scope", "companies", "sectors")
_SYMBOL = re.compile(r"^[A-Z0-9&\-]+\.NS$")
_PLACEHOLDERS = {f"{w}.NS" for w in ("NONE", "NA", "NIL", "NULL", "NO", "-")}   # "no company" typed as one
REPO_ROOT = Path(__file__).resolve().parents[2]


# ── Corpus files (re-read when they change on disk) ──────────────────────────
def _data_dir() -> Path:
    d = get_settings().research_data_dir
    p = Path(d) if d else REPO_ROOT / "data"
    return p if p.is_absolute() else REPO_ROOT / p


_cache: dict[str, tuple[float, object]] = {}


def _cached(path: Path, parse):
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return None
    hit = _cache.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    value = parse(path)
    _cache[str(path)] = (mtime, value)
    return value


def _jsonl(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _sample() -> list[dict]:
    rows = _cached(_data_dir() / "corpus" / "sample.jsonl", _jsonl)
    if rows is None:
        raise HTTPException(404, "No sample drawn yet (python -m research.build_sample sample ...)")
    return rows


def _prelabels() -> dict[str, dict]:
    # Cached as the id -> row dict: rebuilding it per call made /status and
    # /items O(rows^2) (~5 s for 3,000 rows, blocking the event loop).
    return _cached(_data_dir() / "annotation" / "prelabels.jsonl",
                   lambda p: {r["id"]: r for r in _jsonl(p)}) or {}


def _review() -> dict[str, list]:
    doc = _cached(_data_dir() / "annotation" / "prelabel_review.json",
                  lambda p: json.loads(p.read_text(encoding="utf-8")))
    return (doc or {}).get("flags", {})


def eligible(rec: dict) -> bool:
    """Same rule as research.prelabel.eligible: every row (guidelines v1.2)."""
    return rec.get("split") in ("train", "dev", "test")


def queue(role: str) -> list[dict]:
    rows = _sample()
    return rows if role == "A" else [r for r in rows if r.get("double_annotate")]


def _public(rec: dict) -> dict:
    """What an annotator sees of a row. The split is withheld so test rows are
    not labelled with more (or less) care than the rest."""
    return {k: rec[k] for k in ("id", "headline", "source", "published_at")}


# ── Roles ─────────────────────────────────────────────────────────────────────
async def annotator_role(user: CurrentUser, db: AsyncSession) -> str:
    role = (await db.execute(text("SELECT role FROM annotation_roles WHERE user_id=:u"),
                             {"u": user.id})).scalar()
    if role:
        return role.strip()
    if user.is_admin and not (await db.execute(
            text("SELECT 1 FROM annotation_roles WHERE role='A'"))).first():
        return "A"                          # until roles are assigned, the admin is A
    raise HTTPException(403, "You are not an annotator yet. Ask the admin to assign you "
                             "in Research → Annotators.")


# ── Validation (mirrors research/schema.py validate) ─────────────────────────
class LabelIn(BaseModel):
    sentiment: str
    events: list[str]
    severity: str
    scope: str
    companies: list[str] = Field(default_factory=list)
    sectors: list[str] = Field(default_factory=list)
    notes: str | None = None
    seconds: float = 0
    prelabel_shown: bool = False


def normalise(lab: LabelIn) -> tuple[dict, list[str]]:
    events = sorted({e.strip().lower() for e in lab.events if e.strip()})
    companies = []
    for c in lab.companies:
        c = c.strip().upper()
        if c:
            c = c if c.endswith(".NS") else c + ".NS"
            if c not in companies:
                companies.append(c)
    out = {"sentiment": lab.sentiment.strip().lower(), "events": events,
           "severity": lab.severity.strip().lower(), "scope": lab.scope.strip().lower(),
           "companies": companies, "sectors": sorted(set(lab.sectors)),
           "notes": (lab.notes or "").strip() or None}
    errs = []
    if out["sentiment"] not in SENTIMENTS:
        errs.append("choose a sentiment")
    if not events:
        errs.append("choose at least one event type (use 'other' if none fits)")
    elif any(e not in EVENT_TYPES for e in events):
        errs.append(f"unknown event types {[e for e in events if e not in EVENT_TYPES]}")
    elif "other" in events and len(events) > 1:
        errs.append("'other' cannot be combined with another event type")
    if out["severity"] not in SEVERITIES:
        errs.append("choose a severity")
    if out["scope"] not in SCOPES:
        errs.append("choose a scope")
    if out["sentiment"] == "positive" and out["severity"] not in ("none", ""):
        errs.append("good news has severity 'none': severity measures downside only")
    bad = [c for c in companies if not _SYMBOL.match(c) or c in _PLACEHOLDERS]
    if bad:
        errs.append(f"not NSE symbols: {bad}")
    if out["scope"] == "company" and not companies:
        errs.append("scope 'company' needs at least one company; if the company is unlisted "
                    "or foreign, the scope is 'none'")
    bad = [s for s in out["sectors"] if s not in SECTORS]
    if bad:
        errs.append(f"unknown sectors {bad}")
    return out, errs


# ── Endpoints ─────────────────────────────────────────────────────────────────
async def _labels(db: AsyncSession, role: str) -> dict[str, dict]:
    rows = (await db.execute(text(
        "SELECT item_id, sentiment, events, severity, scope, companies, sectors, notes, "
        "prelabel, seconds, updated_at FROM annotations WHERE annotator=:a"), {"a": role})).mappings()
    return {r["item_id"]: dict(r) for r in rows}


def _prefill_for(role: str, rec: dict, pre: dict[str, dict] | None = None) -> dict | None:
    """`pre` is the loaded pre-label table; loops pass it so the file is
    checked once per request, not once per row."""
    if not eligible(rec):
        return None
    lab = (_prelabels() if pre is None else pre).get(rec["id"])
    if not lab:
        return None
    return {f: lab.get(f, []) for f in PRELABEL_FIELDS} | {"model": lab.get("model")}


@router.get("/status")
async def status(user: CurrentUser = Depends(get_current_user),
                 db: AsyncSession = Depends(get_db)) -> dict:
    role = await annotator_role(user, db)
    rows, done, table, flags = queue(role), await _labels(db, role), _prelabels(), _review()
    pre = sum(1 for r in rows if r["id"] not in done and _prefill_for(role, r, table))
    today = (await db.execute(text(
        "SELECT count(*), coalesce(sum(seconds), 0) FROM annotations WHERE annotator=:a "
        "AND (updated_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date"),
        {"a": role})).one()
    n_done = sum(1 for r in rows if r["id"] in done)
    secs = sum(float(done[r["id"]]["seconds"] or 0) for r in rows if r["id"] in done)
    return {"role": role, "total": len(rows), "done": n_done, "prefilled_todo": pre,
            "flagged_todo": sum(1 for r in rows if r["id"] not in done and r["id"] in flags
                                and _prefill_for(role, r, table)) if role == "A" else 0,
            "today": int(today[0]), "avg_seconds": round(secs / n_done, 1) if n_done else None,
            "options": {"sentiment": SENTIMENTS, "events": EVENT_TYPES, "severity": SEVERITIES,
                        "scope": SCOPES, "sectors": SECTORS}}


@router.get("/items")
async def items(view: str = Query("todo", pattern="^(todo|done|prefilled|flagged|all)$"),
                q: str = "", offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                user: CurrentUser = Depends(get_current_user),
                db: AsyncSession = Depends(get_db)) -> dict:
    role = await annotator_role(user, db)
    done, flags, table = await _labels(db, role), (_review() if role == "A" else {}), _prelabels()
    out = []
    for r in queue(role):
        is_done, pre = r["id"] in done, _prefill_for(role, r, table)
        shown = done[r["id"]]["prelabel"] is not None if is_done else pre is not None
        if view == "todo" and is_done or view == "done" and not is_done:
            continue
        if view == "prefilled" and (is_done or not pre) or view == "flagged" and (is_done or not (shown and r["id"] in flags)):
            continue
        if q and q.lower() not in r["headline"].lower():
            continue
        out.append(_public(r) | {"done": is_done, "prefilled": shown,
                                 "flagged": shown and r["id"] in flags,
                                 "sentiment": done[r["id"]]["sentiment"] if is_done else None})
    return {"total": len(out), "items": out[offset:offset + limit]}


def _item_payload(role: str, rows: list[dict], idx: int, done: dict[str, dict],
                  table: dict[str, dict]) -> dict:
    rec = rows[idx]
    item_id = rec["id"]
    saved = done.get(item_id)
    prelabel = (saved["prelabel"] if saved else _prefill_for(role, rec, table))
    nxt = next((r["id"] for r in rows[idx + 1:] + rows[:idx] if r["id"] not in done), None)
    return {"item": _public(rec), "index": idx + 1, "total": len(rows),
            "label": {k: saved[k] for k in ("sentiment", "events", "severity", "scope", "companies",
                                            "sectors", "notes")} if saved else None,
            "prelabel": prelabel,
            "review": _review().get(item_id, []) if role == "A" and prelabel else [],
            "prev_id": rows[idx - 1]["id"] if idx > 0 else None,
            "next_id": rows[idx + 1]["id"] if idx + 1 < len(rows) else None,
            "next_todo_id": nxt}


@router.get("/items/batch")
async def items_batch(ids: str = Query(..., description="comma-separated item ids, at most 30"),
                      user: CurrentUser = Depends(get_current_user),
                      db: AsyncSession = Depends(get_db)) -> dict:
    """Several headlines in one request, so the page can preload the next ones.
    Ids not in the caller's queue are left out (B never gets A-only rows)."""
    wanted = [i for i in dict.fromkeys(ids.split(",")) if i][:30]
    role = await annotator_role(user, db)
    rows, done, table = queue(role), await _labels(db, role), _prelabels()
    pos = {r["id"]: i for i, r in enumerate(rows)}
    return {"items": {i: _item_payload(role, rows, pos[i], done, table) for i in wanted if i in pos}}


@router.get("/items/{item_id}")
async def item(item_id: str, user: CurrentUser = Depends(get_current_user),
               db: AsyncSession = Depends(get_db)) -> dict:
    role = await annotator_role(user, db)
    rows = queue(role)
    idx = next((i for i, r in enumerate(rows) if r["id"] == item_id), None)
    if idx is None:
        raise HTTPException(404, "Not in your queue")
    return _item_payload(role, rows, idx, await _labels(db, role), _prelabels())


@router.put("/items/{item_id}")
async def save(item_id: str, body: LabelIn, user: CurrentUser = Depends(get_current_user),
               db: AsyncSession = Depends(get_db)) -> dict:
    role = await annotator_role(user, db)
    rec = next((r for r in queue(role) if r["id"] == item_id), None)
    if rec is None:
        raise HTTPException(404, "Not in your queue")
    lab, errs = normalise(body)
    if errs:
        raise HTTPException(422, "; ".join(errs))
    # The pre-label is recorded only if this annotator may see one and was shown it.
    pre = _prefill_for(role, rec, _prelabels()) if body.prelabel_shown else None
    await db.execute(text(
        "INSERT INTO annotations (item_id, annotator, user_id, sentiment, events, severity, scope,"
        " companies, sectors, notes, prelabel, seconds) VALUES (:i, :a, :u, :s, CAST(:e AS JSONB), :sev,"
        " :sc, CAST(:c AS JSONB), CAST(:sec AS JSONB), :n, CAST(:p AS JSONB), :t)"
        " ON CONFLICT (item_id, annotator) DO UPDATE SET user_id=EXCLUDED.user_id,"
        " sentiment=EXCLUDED.sentiment, events=EXCLUDED.events, severity=EXCLUDED.severity,"
        " scope=EXCLUDED.scope, companies=EXCLUDED.companies, sectors=EXCLUDED.sectors,"
        " notes=EXCLUDED.notes, prelabel=COALESCE(annotations.prelabel, EXCLUDED.prelabel),"
        " seconds=annotations.seconds + EXCLUDED.seconds, updated_at=now()"),
        {"i": item_id, "a": role, "u": user.id, "s": lab["sentiment"], "e": json.dumps(lab["events"]),
         "sev": lab["severity"], "sc": lab["scope"], "c": json.dumps(lab["companies"]),
         "sec": json.dumps(lab["sectors"]), "n": lab["notes"],
         "p": json.dumps(pre) if pre else None, "t": max(0.0, min(body.seconds, 600.0))})
    await db.commit()
    return {"saved": item_id, "label": lab}


@router.delete("/items/{item_id}")
async def clear(item_id: str, user: CurrentUser = Depends(get_current_user),
                db: AsyncSession = Depends(get_db)) -> dict:
    role = await annotator_role(user, db)
    await db.execute(text("DELETE FROM annotations WHERE item_id=:i AND annotator=:a"),
                     {"i": item_id, "a": role})
    await db.commit()
    return {"cleared": item_id}


@router.get("/companies")
async def companies(q: str, db: AsyncSession = Depends(get_db),
                    _: CurrentUser = Depends(get_current_user)) -> dict:
    """Symbol lookup over the full NSE list (nse_catalog) and the engine
    universe. Typed by the annotator; never suggested from the headline."""
    term = (q or "").strip()
    if len(term) < 2:
        return {"results": []}
    like, starts = f"%{term}%", f"{term}%"
    has_cat = (await db.execute(text("SELECT to_regclass('nse_catalog') IS NOT NULL"))).scalar()
    cat = ("UNION SELECT symbol, company_name FROM nse_catalog "
           "WHERE symbol ILIKE :l OR company_name ILIKE :l") if has_cat else ""
    rows = (await db.execute(text(
        f"SELECT symbol, max(company_name) AS name FROM (SELECT symbol, company_name FROM stock_universe "
        f"WHERE symbol ILIKE :l OR company_name ILIKE :l {cat}) x GROUP BY symbol "
        f"ORDER BY (symbol ILIKE :s OR max(company_name) ILIKE :s) DESC, length(symbol) LIMIT 10"),
        {"l": like, "s": starts})).all()
    return {"results": [{"symbol": r[0], "name": r[1]} for r in rows]}


# ── Admin: who is annotator A and B ──────────────────────────────────────────
class RoleIn(BaseModel):
    user_id: int
    role: str | None = None


@router.get("/annotators")
async def annotators(user: CurrentUser = Depends(get_current_user),
                     db: AsyncSession = Depends(get_db)) -> dict:
    if not user.is_admin:
        raise HTTPException(403, "Admin only")
    rows = (await db.execute(text(
        "SELECT u.id, u.username, u.display_name, r.role FROM users u "
        "LEFT JOIN annotation_roles r ON r.user_id = u.id ORDER BY u.id"))).all()
    counts = dict((await db.execute(text(
        "SELECT annotator, count(*) FROM annotations GROUP BY annotator"))).all())
    return {"users": [{"id": r[0], "username": r[1], "display_name": r[2],
                       "role": r[3].strip() if r[3] else None} for r in rows],
            "progress": {"A": {"done": counts.get("A", 0), "total": len(queue("A"))},
                         "B": {"done": counts.get("B", 0), "total": len(queue("B"))}}}


@router.put("/annotators")
async def set_annotator(body: RoleIn, user: CurrentUser = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)) -> dict:
    if not user.is_admin:
        raise HTTPException(403, "Admin only")
    if body.role not in (None, "A", "B"):
        raise HTTPException(422, "role must be A, B or empty")
    await db.execute(text("DELETE FROM annotation_roles WHERE user_id=:u"), {"u": body.user_id})
    if body.role:
        await db.execute(text("DELETE FROM annotation_roles WHERE role=:r"), {"r": body.role})
        await db.execute(text("INSERT INTO annotation_roles (user_id, role) VALUES (:u, :r)"),
                         {"u": body.user_id, "r": body.role})
    await db.commit()
    return {"user_id": body.user_id, "role": body.role}
