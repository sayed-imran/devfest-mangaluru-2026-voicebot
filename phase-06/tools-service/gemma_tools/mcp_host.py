"""Connects to the configured MCP servers and exposes their tools to the LLM."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mcp import Client, StdioServerParameters

if sys.version_info < (3, 11):
    from exceptiongroup import BaseExceptionGroup

log = logging.getLogger("gemma_tools.mcp")

_NAME_RE = re.compile(r"[^A-Za-z0-9_-]")
_ERROR_PREFIX = re.compile(r"^Error executing tool [\w.-]+:\s*")
_DROP_SCHEMA_KEYS = {"title", "$defs", "definitions", "$schema", "additionalProperties"}
_MAX_RESULT_CHARS = 12_000
_MAX_VALUE_CHARS = 300


@dataclass
class ServerConfig:
    name: str
    description: str = ""
    builtin: str = ""
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    cwd: str | None = None
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    fast_confirm: bool = False
    route_hint: str = ""
    timeout_s: float = 30.0

    @property
    def transport(self) -> str:
        if self.builtin:
            return "in-process"
        return "http" if self.url else "stdio"


def _expand(value: Any) -> str:
    return os.path.expandvars(str(value))


def load_server_configs(path: Path) -> list[ServerConfig]:
    """Read a Claude/Cursor-style `{"mcpServers": {...}}` file."""
    if not path.is_file():
        log.warning("MCP config %s not found; using only the built-in desktop server", path)
        return [ServerConfig(name="desktop", builtin="desktop", fast_confirm=True)]
    raw = json.loads(path.read_text(encoding="utf-8"))
    servers = raw.get("mcpServers", raw) if isinstance(raw, dict) else {}
    configs: list[ServerConfig] = []
    for name, entry in servers.items():
        if not isinstance(entry, dict) or entry.get("disabled") or entry.get("enabled") is False:
            continue
        cfg = ServerConfig(
            name=str(name),
            description=str(entry.get("description", "")),
            builtin=str(entry.get("builtin", "")),
            command=_expand(entry.get("command", "")),
            args=[_expand(a) for a in entry.get("args", [])],
            env={str(k): _expand(v) for k, v in (entry.get("env") or {}).items()},
            cwd=_expand(entry["cwd"]) if entry.get("cwd") else None,
            url=_expand(entry.get("url", "")),
            headers={str(k): _expand(v) for k, v in (entry.get("headers") or {}).items()},
            fast_confirm=bool(entry.get("fastConfirm", False)),
            route_hint=str(entry.get("routeHint", "")),
            timeout_s=float(entry.get("timeoutSeconds", 30)),
        )
        if not (cfg.builtin or cfg.command or cfg.url):
            log.warning("Skipping MCP server %r: it needs `builtin`, `command` or `url`", name)
            continue
        configs.append(cfg)
    return configs


def _client_target(cfg: ServerConfig) -> Any:
    if cfg.builtin:
        if cfg.builtin == "desktop":
            from .desktop.server import server

            return server
        raise ValueError(f"unknown built-in server {cfg.builtin!r}")
    if cfg.url:
        if not cfg.headers:
            return cfg.url
        import httpx2
        from mcp.client.streamable_http import streamable_http_client

        http = httpx2.AsyncClient(headers=cfg.headers, timeout=httpx2.Timeout(30.0, read=300.0))
        return streamable_http_client(cfg.url, http_client=http)
    # "python" means this service's interpreter, so a venv works the same on every OS.
    command = sys.executable if cfg.command in ("python", "python3", "py") else cfg.command
    return StdioServerParameters(
        command=command,
        args=cfg.args,
        # The SDK only forwards a minimal environment by default; GUI and PATH settings matter here.
        env={**os.environ, **cfg.env},
        cwd=cfg.cwd,
    )


def describe_error(exc: BaseException) -> str:
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def llm_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline $refs, fold Optional[...] into `nullable`, and drop keys chat templates don't use."""
    defs = schema.get("$defs") or schema.get("definitions") or {}

    def clean(node: Any, depth: int = 0) -> Any:
        if isinstance(node, list):
            return [clean(item, depth) for item in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str) and depth < 8:
            target = defs.get(ref.rsplit("/", 1)[-1])
            if isinstance(target, dict):
                merged = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
                return clean(merged, depth + 1)
        variants = node.get("anyOf") or node.get("oneOf")
        if isinstance(variants, list):
            non_null = [v for v in variants if not (isinstance(v, dict) and v.get("type") == "null")]
            if len(non_null) == 1 and len(non_null) < len(variants):
                merged = {k: v for k, v in node.items() if k not in ("anyOf", "oneOf")}
                merged.update(non_null[0])
                merged["nullable"] = True
                return clean(merged, depth)
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in _DROP_SCHEMA_KEYS:
                continue
            if key == "properties" and isinstance(value, dict):
                out[key] = {prop: clean(sub, depth) for prop, sub in value.items()}
            else:
                out[key] = clean(value, depth)
        return out

    cleaned = clean(schema)
    cleaned.setdefault("type", "object")
    cleaned.setdefault("properties", {})
    return cleaned


@dataclass
class ToolEntry:
    name: str
    remote_name: str
    server: str
    title: str
    description: str
    input_schema: dict[str, Any]
    fast_confirm: bool

    def openai(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": llm_schema(self.input_schema),
            },
        }


@dataclass
class ToolOutcome:
    ok: bool
    message: str
    text: str
    data: dict[str, Any] | None = None


def _llm_payload(data: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in data.items():
        if key == "opened_with":
            continue
        if isinstance(value, str) and len(value) > _MAX_VALUE_CHARS:
            value = value[:_MAX_VALUE_CHARS] + "…"
        payload[key] = value
    return payload


def to_outcome(result: Any) -> ToolOutcome:
    texts = [c.text for c in result.content if getattr(c, "type", "") == "text"]
    text = "\n".join(texts).strip()
    data = result.structured_content if isinstance(result.structured_content, dict) else None
    if data is None and text.startswith("{"):
        try:
            parsed = json.loads(text)
            data = parsed if isinstance(parsed, dict) else None
        except ValueError:
            data = None
    if result.is_error:
        message = _ERROR_PREFIX.sub("", text) or "The tool failed."
        return ToolOutcome(False, message, json.dumps({"ok": False, "error": message}), data)
    ok = bool(data.get("ok", True)) if data else True
    message = str(data["message"]) if data and data.get("message") else (text[:300] or "Done.")
    llm_text = json.dumps(_llm_payload(data), ensure_ascii=False) if data else (text or "Done.")
    return ToolOutcome(ok, message, llm_text[:_MAX_RESULT_CHARS], data)


async def _list_all_tools(client: Client) -> list[Any]:
    tools: list[Any] = []
    cursor: str | None = None
    for _ in range(50):
        page = await client.list_tools(cursor=cursor)
        tools.extend(page.tools)
        cursor = page.next_cursor
        if not cursor:
            break
    return tools


class ServerConnection:
    """One MCP server; the client lives in its own task so the SDK's cancel scopes stay put."""

    def __init__(self, cfg: ServerConfig) -> None:
        self.cfg = cfg
        self.client: Client | None = None
        self.tools: list[Any] = []
        self.error = ""
        self._task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._lock = asyncio.Lock()

    async def start(self, timeout_s: float = 30.0) -> None:
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self.error = ""
        self._task = asyncio.create_task(self._run(), name=f"mcp:{self.cfg.name}")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout_s)
        except asyncio.TimeoutError:
            self.error = f"no response within {timeout_s:.0f}s"
            await self.stop()

    async def _run(self) -> None:
        try:
            target = _client_target(self.cfg)
            async with Client(target, read_timeout_seconds=self.cfg.timeout_s) as client:
                self.tools = await _list_all_tools(client)
                self.client = client
                self._ready.set()
                await self._stop.wait()
        except Exception as exc:  # noqa: BLE001 - reported via /health
            self.error = describe_error(exc)
            log.warning("MCP server %r is unavailable: %s", self.cfg.name, self.error)
        finally:
            self.client = None
            self._ready.set()

    async def stop(self) -> None:
        self._stop.set()
        task = self._task
        if task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), 10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
        except Exception:  # noqa: BLE001
            pass

    async def call(self, name: str, arguments: dict[str, Any]) -> Any:
        if self.client is None:
            async with self._lock:
                if self.client is None:
                    log.info("Reconnecting MCP server %r", self.cfg.name)
                    await self.start()
        client = self.client
        if client is None:
            raise ConnectionError(self.error or "not connected")
        return await client.call_tool(name, arguments, read_timeout_seconds=self.cfg.timeout_s)


class MCPHost:
    def __init__(self, configs: list[ServerConfig]) -> None:
        self.connections = [ServerConnection(cfg) for cfg in configs]
        self._tools: dict[str, tuple[ServerConnection, ToolEntry]] = {}

    async def start(self) -> None:
        await asyncio.gather(*(conn.start() for conn in self.connections))
        self._rebuild()
        for conn in self.connections:
            state = f"{len(conn.tools)} tools" if conn.client else f"offline ({conn.error})"
            log.info("MCP server %r [%s]: %s", conn.cfg.name, conn.cfg.transport, state)

    async def stop(self) -> None:
        await asyncio.gather(*(conn.stop() for conn in self.connections), return_exceptions=True)

    def _rebuild(self) -> None:
        tools: dict[str, tuple[ServerConnection, ToolEntry]] = {}
        for conn in self.connections:
            for tool in conn.tools:
                name = _NAME_RE.sub("_", tool.name)[:64]
                if name in tools:
                    name = _NAME_RE.sub("_", f"{conn.cfg.name}__{tool.name}")[:64]
                title = tool.title or (tool.annotations.title if tool.annotations else None) or tool.name
                tools[name] = (
                    conn,
                    ToolEntry(
                        name=name,
                        remote_name=tool.name,
                        server=conn.cfg.name,
                        title=title,
                        description=(tool.description or title).strip(),
                        input_schema=tool.input_schema or {"type": "object", "properties": {}},
                        fast_confirm=conn.cfg.fast_confirm,
                    ),
                )
        self._tools = tools

    @property
    def tools(self) -> list[ToolEntry]:
        return [entry for _, entry in self._tools.values()]

    def get(self, name: str) -> ToolEntry | None:
        pair = self._tools.get(name)
        return pair[1] if pair else None

    def openai_tools(self) -> list[dict[str, Any]]:
        return [entry.openai() for entry in self.tools]

    def route_hints(self) -> list[str]:
        return [conn.cfg.route_hint for conn in self.connections if conn.client and conn.cfg.route_hint]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolOutcome:
        pair = self._tools.get(name)
        if pair is None:
            message = f"There's no tool called {name}."
            return ToolOutcome(False, message, json.dumps({"ok": False, "error": message}))
        conn, entry = pair
        try:
            result = await conn.call(entry.remote_name, arguments)
        except Exception as exc:  # noqa: BLE001 - surfaced to the LLM and the UI
            message = f"The {conn.cfg.name} tools aren't available right now ({describe_error(exc)})."
            return ToolOutcome(False, message, json.dumps({"ok": False, "error": message}))
        return to_outcome(result)

    def status(self) -> list[dict[str, Any]]:
        return [
            {
                "name": conn.cfg.name,
                "transport": conn.cfg.transport,
                "connected": conn.client is not None,
                "tools": len(conn.tools) if conn.client else 0,
                "error": conn.error or None,
            }
            for conn in self.connections
        ]
