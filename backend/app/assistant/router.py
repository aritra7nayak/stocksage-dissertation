"""HTTP API for the assistant (used by the web app and, later, the Android app)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.assistant import agent, llm, tools
from app.auth_router import CurrentUser, get_current_user
from app.db.database import get_db

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class Turn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default_factory=list, max_length=20)


@router.post("/chat")
async def chat(body: ChatIn, user: CurrentUser = Depends(get_current_user),
               db: AsyncSession = Depends(get_db)) -> dict:
    try:
        return await agent.answer(body.message, [t.model_dump() for t in body.history],
                                  tools.Ctx(db=db, user_id=user.id))
    except llm.LLMUnavailable as e:
        raise HTTPException(503, str(e)) from e


@router.get("/status")
async def status() -> dict:
    return {"llm": await llm.status(), "tools": list(tools.TOOLS)}
