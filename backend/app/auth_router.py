"""Authentication — users, passwords, JWT sessions.

POST /api/auth/register  {username, password, display_name?} → token
POST /api/auth/login     {username, password}                → token
GET  /api/auth/me        (Bearer token)                      → user info

Design:
- Passwords: PBKDF2-HMAC-SHA256, 200k iterations, per-user salt (stdlib only).
- Tokens: JWT (pyjwt), 30-day expiry, secret from AUTH_SECRET env var or a
  generated fallback persisted to .auth_secret next to the app.
- First user to register becomes admin.
- get_current_user is the dependency every user-scoped router imports.

Requires:  pip install pyjwt --break-system... (Windows venv: pip install pyjwt)
"""
import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import get_db

logger = logging.getLogger("stocksage.auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=False)

ITERATIONS = 200_000
TOKEN_DAYS = 30


def _secret() -> str:
    env = os.environ.get("AUTH_SECRET")
    if env:
        return env
    p = Path(__file__).resolve().parent.parent / ".auth_secret"
    if p.exists():
        return p.read_text().strip()
    s = secrets.token_hex(32)
    try:
        p.write_text(s)
    except Exception:
        logger.warning("Could not persist auth secret — tokens reset on restart")
    return s


SECRET = _secret()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), ITERATIONS)
    return f"pbkdf2:sha256:{ITERATIONS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        meta, salt, hexhash = stored.split("$")
        iters = int(meta.split(":")[2])
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iters)
        return secrets.compare_digest(dk.hex(), hexhash)
    except Exception:
        return False


def make_token(user_id: int, username: str, is_admin: bool) -> str:
    payload = {"sub": str(user_id), "username": username, "adm": is_admin,
               "exp": datetime.now(timezone.utc) + timedelta(days=TOKEN_DAYS)}
    return jwt.encode(payload, SECRET, algorithm="HS256")


class CurrentUser(BaseModel):
    id: int
    username: str
    display_name: str | None = None
    is_admin: bool = False


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    """Dependency: resolves the Bearer token to a user, or 401."""
    if creds is None:
        raise HTTPException(401, "Not signed in")
    try:
        payload = jwt.decode(creds.credentials, SECRET, algorithms=["HS256"])
        uid = int(payload["sub"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired — sign in again")
    except Exception:
        raise HTTPException(401, "Invalid session")
    row = (await db.execute(text(
        "SELECT id, username, display_name, is_admin FROM users WHERE id=:i"),
        {"i": uid})).first()
    if not row:
        raise HTTPException(401, "User no longer exists")
    return CurrentUser(id=row[0], username=row[1], display_name=row[2], is_admin=bool(row[3]))


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=48, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=6, max_length=128)
    display_name: str | None = Field(default=None, max_length=80)


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/register")
async def register(body: RegisterIn, db: AsyncSession = Depends(get_db)) -> dict:
    uname = body.username.lower().strip()
    exists = (await db.execute(text("SELECT 1 FROM users WHERE username=:u"), {"u": uname})).first()
    if exists:
        raise HTTPException(409, "That username is taken")
    count = (await db.execute(text("SELECT count(*) FROM users"))).scalar_one()
    # The first account always gets through, so a fresh install can bootstrap.
    # Beyond that registration is closed unless explicitly opened, because this
    # endpoint is reachable by anyone once the app is published.
    if count > 0 and not get_settings().allow_registration:
        raise HTTPException(403, "Registration is closed on this instance")
    row = (await db.execute(text(
        "INSERT INTO users (username, display_name, password_hash, is_admin) "
        "VALUES (:u, :d, :p, :a) RETURNING id"),
        {"u": uname, "d": body.display_name or body.username, "p": hash_password(body.password),
         "a": count == 0})).first()
    uid = row[0]
    if count == 0:
        # First user (admin) CLAIMS all pre-existing single-user data so the
        # original paper history, settings and snapshots stay theirs.
        claimed = (await db.execute(text(
            "UPDATE portfolios SET user_id=:u WHERE user_id IS NULL RETURNING id"), {"u": uid})).first()
        await db.execute(text("UPDATE app_settings SET user_id=:u WHERE user_id IS NULL"), {"u": uid})
        await db.execute(text("UPDATE portfolio_snapshots SET user_id=:u WHERE user_id IS NULL"), {"u": uid})
        await db.execute(text("UPDATE trade_config_log SET user_id=:u WHERE user_id IS NULL"), {"u": uid})
        if not claimed:
            await db.execute(text(
                "INSERT INTO portfolios (name, total_capital, cash_balance, is_paper, user_id) "
                "VALUES (:n, 100000, 100000, TRUE, :u)"),
                {"n": f"{body.display_name or body.username}'s Portfolio", "u": uid})
    else:
        # Every new user gets their own fresh paper portfolio.
        await db.execute(text(
            "INSERT INTO portfolios (name, total_capital, cash_balance, is_paper, user_id) "
            "VALUES (:n, 100000, 100000, TRUE, :u)"),
            {"n": f"{body.display_name or body.username}'s Portfolio", "u": uid})
    await db.commit()
    logger.info("New user registered: %s%s", uname, " (admin)" if count == 0 else "")
    return {"token": make_token(uid, uname, count == 0),
            "user": {"id": uid, "username": uname,
                     "display_name": body.display_name or body.username,
                     "is_admin": count == 0}}


@router.post("/login")
async def login(body: LoginIn, db: AsyncSession = Depends(get_db)) -> dict:
    uname = body.username.lower().strip()
    row = (await db.execute(text(
        "SELECT id, username, display_name, password_hash, is_admin FROM users WHERE username=:u"),
        {"u": uname})).first()
    if not row or not verify_password(body.password, row[3]):
        raise HTTPException(401, "Wrong username or password")
    return {"token": make_token(row[0], row[1], bool(row[4])),
            "user": {"id": row[0], "username": row[1],
                     "display_name": row[2], "is_admin": bool(row[4])}}


@router.get("/me")
async def me(user: CurrentUser = Depends(get_current_user)) -> dict:
    return user.model_dump()
