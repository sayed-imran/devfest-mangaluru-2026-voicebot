"""OpenAI-compatible chat client with tool calls (vLLM on the DGX Spark, Gemma 4).

Servers differ in how they surface a tool call:

* vLLM with `--enable-auto-tool-choice --tool-call-parser gemma4` returns
  structured `tool_calls` on the message.
* Anything else leaves Gemma's native `<|tool_call>call:name{...}<tool_call|>`
  text sitting in `content`.

Both are handled below, so the agent keeps working even if the Spark is
started without the tool-call parser.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

STRING_DELIM = '<|"|>'

_GEMMA_CALL = re.compile(r"<\|tool_call>call:([\w.-]+)\{(.*?)\}(?:<tool_call\|>|<turn\|>|$)", re.S)
_HERMES_CALL = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)
_CHANNEL = re.compile(r"<\|channel>.*?<channel\|>", re.S)
_SPECIAL = re.compile(r"<\|?(?:turn|tool_response|tool_call|channel|tool|\"|think)\|?>")
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


class LLMError(RuntimeError):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]

    def as_message_part(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": json.dumps(self.arguments, ensure_ascii=False)},
        }


@dataclass
class AssistantTurn:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = ""


def _bare_value(raw: str) -> Any:
    value = raw.strip()
    if value == "true":
        return True
    if value == "false":
        return False
    if value in ("null", "None"):
        return None
    if _NUMBER.fullmatch(value):
        return float(value) if any(c in value for c in ".eE") else int(value)
    return value


class _GemmaArgs:
    """Parser for Gemma 4's compact argument syntax: key:<|"|>text<|"|>,n:3,obj:{...},list:[...]."""

    def __init__(self, text: str) -> None:
        self.s = text
        self.i = 0

    def _skip(self, chars: str = " \t\r\n,") -> None:
        while self.i < len(self.s) and self.s[self.i] in chars:
            self.i += 1

    def _string(self) -> str:
        self.i += len(STRING_DELIM)
        end = self.s.find(STRING_DELIM, self.i)
        if end == -1:
            value, self.i = self.s[self.i :], len(self.s)
        else:
            value, self.i = self.s[self.i : end], end + len(STRING_DELIM)
        return value

    def value(self) -> Any:
        self._skip(" \t\r\n")
        if self.s.startswith(STRING_DELIM, self.i):
            return self._string()
        if self.i < len(self.s) and self.s[self.i] == "{":
            self.i += 1
            return self.obj(end="}")
        if self.i < len(self.s) and self.s[self.i] == "[":
            self.i += 1
            items: list[Any] = []
            while True:
                self._skip()
                if self.i >= len(self.s) or self.s[self.i] == "]":
                    self.i += 1
                    return items
                items.append(self.value())
        start = self.i
        while self.i < len(self.s) and self.s[self.i] not in ",}]":
            self.i += 1
        return _bare_value(self.s[start : self.i])

    def obj(self, end: str = "") -> dict[str, Any]:
        result: dict[str, Any] = {}
        while True:
            self._skip()
            if self.i >= len(self.s):
                return result
            if end and self.s[self.i] == end:
                self.i += 1
                return result
            if self.s.startswith(STRING_DELIM, self.i):
                key = self._string()
                self._skip(" \t\r\n")
                if self.i < len(self.s) and self.s[self.i] == ":":
                    self.i += 1
            else:
                colon = self.s.find(":", self.i)
                if colon == -1:
                    return result
                key = self.s[self.i : colon].strip()
                self.i = colon + 1
            result[key] = self.value()


def parse_gemma_args(text: str) -> dict[str, Any]:
    return _GemmaArgs(text).obj()


def parse_text_tool_calls(content: str) -> list[ToolCall]:
    """Tool calls written as text (Gemma native or Hermes JSON) when vLLM didn't parse them."""
    calls = [
        ToolCall(f"call_{uuid.uuid4().hex[:12]}", m.group(1), parse_gemma_args(m.group(2)))
        for m in _GEMMA_CALL.finditer(content or "")
    ]
    if calls:
        return calls
    for match in _HERMES_CALL.finditer(content or ""):
        try:
            data = json.loads(match.group(1))
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("name"), str):
            args = data.get("arguments") or data.get("parameters") or {}
            calls.append(ToolCall(f"call_{uuid.uuid4().hex[:12]}", data["name"], args if isinstance(args, dict) else {}))
    return calls


def clean_text(content: str) -> str:
    """Drop thinking channels, tool-call markup and stray special tokens from a reply."""
    text = _CHANNEL.sub("", content or "")
    text = _GEMMA_CALL.sub("", text)
    text = _HERMES_CALL.sub("", text)
    text = _SPECIAL.sub("", text)
    return text.strip()


def _parse_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


class LLMClient:
    def __init__(self, base_url: str, model: str, api_key: str = "", timeout_s: float = 90.0) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.model = model
        self.base_url = base_url
        self._http = httpx.AsyncClient(base_url=base_url, headers=headers, timeout=timeout_s)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def health(self) -> dict[str, Any]:
        try:
            res = await self._http.get("/v1/models", timeout=4.0)
            res.raise_for_status()
            return {"ok": True, "model": self.model}
        except httpx.HTTPError as exc:
            return {"ok": False, "model": self.model, "error": str(exc) or type(exc).__name__}

    async def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 700,
        temperature: float = 0.2,
    ) -> AssistantTurn:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        try:
            res = await self._http.post("/v1/chat/completions", json=payload)
        except httpx.HTTPError as exc:
            raise LLMError(f"LLM unreachable at {self.base_url} ({type(exc).__name__})") from exc
        if res.status_code >= 400:
            raise LLMError(f"LLM failed ({res.status_code}): {res.text[:300]}")
        data = res.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = message.get("content") or ""
        calls = [
            ToolCall(
                tc.get("id") or f"call_{uuid.uuid4().hex[:12]}",
                (tc.get("function") or {}).get("name", ""),
                _parse_arguments((tc.get("function") or {}).get("arguments")),
            )
            for tc in message.get("tool_calls") or []
            if (tc.get("function") or {}).get("name")
        ]
        if not calls and tools:
            calls = parse_text_tool_calls(content)
        return AssistantTurn(clean_text(content), calls, choice.get("finish_reason") or "")
