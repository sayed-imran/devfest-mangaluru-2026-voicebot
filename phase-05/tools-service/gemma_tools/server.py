"""FastAPI app: MCP tools, Laya routing and the tool-calling agent over HTTP."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .agent import run_agent
from .config import get_desktop_settings, get_settings
from .desktop.launcher import desktop_status, platform_label
from .llm import LLMClient, LLMError
from .mcp_host import MCPHost, describe_error, load_server_configs
from .routing import LayaClient, decide_route

log = logging.getLogger("gemma_tools")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    host = MCPHost(load_server_configs(settings.mcp_config))
    await host.start()
    app.state.host = host
    app.state.llm = LLMClient(
        settings.llm_base_url, settings.llm_model, settings.llm_api_key, settings.llm_timeout_s
    )
    app.state.laya = LayaClient(settings.laya_base_url, settings.laya_timeout_ms)
    app.state.os_name = platform_label()
    log.info(
        "Gemma tools ready on http://%s:%s · %s · %d tools · LLM %s · Laya %s%s",
        settings.host,
        settings.port,
        app.state.os_name,
        len(host.tools),
        settings.llm_base_url,
        settings.laya_base_url,
        " · DRY RUN" if get_desktop_settings().dry_run else "",
    )
    try:
        yield
    finally:
        await host.stop()
        await app.state.llm.aclose()
        await app.state.laya.aclose()


app = FastAPI(title="Gemma tools service", version=__version__, lifespan=lifespan)

_settings = get_settings()
_allowed_hosts = (
    ["*"]
    if _settings.api_key
    else ["localhost", "127.0.0.1", "[::1]", "::1", *_settings.allowed_hosts]
)
# Blocks DNS-rebinding requests from web pages when no API key protects the service.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts)


def require_key(
    authorization: str = Header(default=""),
    x_api_key: str = Header(default=""),
) -> None:
    expected = get_settings().api_key
    if not expected:
        return
    token = authorization[7:] if authorization.lower().startswith("bearer ") else x_api_key
    if not secrets.compare_digest(token.strip(), expected):
        raise HTTPException(status_code=401, detail="Missing or wrong TOOLS_API_KEY")


api = APIRouter(prefix="/v1", dependencies=[Depends(require_key)])


class ChatMessage(BaseModel):
    role: str
    content: str


class AgentRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)
    stream: bool = True


class RouteRequest(BaseModel):
    text: str
    last_assistant: str = ""


class ToolCallRequest(BaseModel):
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


@app.get("/")
async def index() -> dict[str, Any]:
    return {"service": "gemma-tools", "version": __version__, "docs": "/docs", "health": "/health"}


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    state = request.app.state
    llm, laya = await asyncio.gather(state.llm.health(), state.laya.health())
    desktop = await asyncio.to_thread(desktop_status)
    servers = state.host.status()
    return {
        "ok": any(s["connected"] for s in servers),
        "version": __version__,
        "os": state.os_name,
        "dry_run": get_desktop_settings().dry_run,
        "desktop": desktop,
        "tools": len(state.host.tools),
        "servers": servers,
        "llm": llm,
        "laya": laya,
    }


@api.get("/tools")
async def list_tools(request: Request) -> dict[str, Any]:
    return {
        "tools": [
            {
                "name": t.name,
                "server": t.server,
                "title": t.title,
                "description": t.description,
                "parameters": t.openai()["function"]["parameters"],
            }
            for t in request.app.state.host.tools
        ]
    }


@api.post("/tools/call")
async def call_tool(body: ToolCallRequest, request: Request) -> dict[str, Any]:
    outcome = await request.app.state.host.call_tool(body.name, body.arguments)
    return {"ok": outcome.ok, "message": outcome.message, "data": outcome.data}


@api.post("/route")
async def route(body: RouteRequest, request: Request) -> dict[str, Any]:
    settings = get_settings()
    decision = await decide_route(
        request.app.state.laya,
        body.text,
        last_assistant=body.last_assistant,
        hints=request.app.state.host.route_hints(),
        threshold=settings.route_threshold,
    )
    return decision.as_dict()


async def _agent_events(body: AgentRequest, request: Request) -> AsyncIterator[dict[str, Any]]:
    settings = get_settings()
    try:
        async for event in run_agent(
            host=request.app.state.host,
            llm=request.app.state.llm,
            messages=[m.model_dump() for m in body.messages],
            os_name=request.app.state.os_name,
            user_name=settings.user_name,
            max_steps=settings.max_steps,
            fast_confirm=settings.fast_confirm,
        ):
            yield event
    except LLMError as exc:
        yield {"type": "error", "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 - reported to the client
        log.exception("Agent failed")
        yield {"type": "error", "message": describe_error(exc)}


@api.post("/agent", response_model=None)
async def agent(body: AgentRequest, request: Request) -> StreamingResponse | dict[str, Any]:
    if not body.stream:
        events = [event async for event in _agent_events(body, request)]
        final = next((e for e in reversed(events) if e["type"] in ("final", "error")), None)
        return {"final": final, "events": events}

    async def sse() -> AsyncIterator[str]:
        async for event in _agent_events(body, request):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


app.include_router(api)
