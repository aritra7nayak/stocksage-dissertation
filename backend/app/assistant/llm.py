"""Client for the assistant's language model.

The model runs in llama.cpp's llama-server, which speaks the OpenAI chat
completions format (with tool calling when started with --jinja). Any other
OpenAI-compatible server works the same way, so the model behind the
assistant is a configuration choice: ASSISTANT_LLM_URL and ASSISTANT_MODEL.
"""
from __future__ import annotations

import httpx

from app.config import get_settings


class LLMUnavailable(RuntimeError):
    pass


async def chat(messages: list[dict], tools: list[dict] | None = None, temperature: float | None = None,
               max_tokens: int = 1024) -> dict:
    """One completion. Returns the assistant message dict (content and/or tool_calls)."""
    s = get_settings()
    body = {"model": s.assistant_model, "messages": messages,
            "temperature": s.assistant_temperature if temperature is None else temperature,
            "max_tokens": max_tokens,
            # Qwen3.5 thinks aloud by default; answers here must be short and grounded.
            "chat_template_kwargs": {"enable_thinking": False}}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    try:
        async with httpx.AsyncClient(timeout=s.assistant_timeout_s) as client:
            r = await client.post(f"{s.assistant_llm_url.rstrip('/')}/chat/completions", json=body)
    except httpx.HTTPError as e:
        raise LLMUnavailable(f"the assistant model server is not reachable at {s.assistant_llm_url} "
                             f"({type(e).__name__}); start it with deploy/slm/start-slm.bat") from e
    if r.status_code != 200:
        raise LLMUnavailable(f"model server error {r.status_code}: {r.text[:300]}")
    data = r.json()
    msg = data["choices"][0]["message"]
    msg["_usage"] = data.get("usage", {})
    return msg


async def status() -> dict:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{s.assistant_llm_url.rstrip('/')}/models")
        models = [m.get("id") for m in r.json().get("data", [])] if r.status_code == 200 else []
        return {"reachable": r.status_code == 200, "url": s.assistant_llm_url, "models": models}
    except httpx.HTTPError as e:
        return {"reachable": False, "url": s.assistant_llm_url, "error": type(e).__name__}
