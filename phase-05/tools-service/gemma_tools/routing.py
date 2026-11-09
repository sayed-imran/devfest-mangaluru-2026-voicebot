"""Decide per turn whether the user wants an action on the computer or just a chat.

Laya (System 1) answers one typed `choice` question in a single forward pass;
a few keyword rules cover what Laya misses and keep routing working when
Laya is offline.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

ACT_CRITERIA = (
    "a command to open, launch, search, look up, play, watch, show, navigate to, "
    "or draft/compose an email on the computer"
)
TALK_CRITERIA = (
    "small talk or a question to answer in words (facts, explanations, opinions, "
    "writing help, how-to), no computer action"
)


def route_questions(extra_hints: list[str] | None = None) -> dict[str, Any]:
    act = ACT_CRITERIA + "".join(f"; {hint}" for hint in extra_hints or [] if hint)
    return {
        "intent": {
            "type": "choice",
            "instructions": "Which kind of request is this for a desktop voice assistant?",
            "criteria": {"act": act, "talk": TALK_CRITERIA},
        }
    }


_LEAD_IN = (
    r"(?:(?:hey|hi|ok|okay|so|um|uh)[\s,]+)*(?:gemma[\s,]+)?"
    r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+|kindly\s+|just\s+|"
    r"i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+|i'?d\s+like\s+(?:you\s+)?to\s+|"
    r"let'?s\s+|go\s+ahead\s+and\s+|quickly\s+)*"
)
_MAIL = r"(?:an?\s+|the\s+|me\s+|up\s+|quick\s+|short\s+|new\s+|formal\s+)*(?:e-?mail|mail|gmail)"
_COMMAND = re.compile(
    rf"^{_LEAD_IN}(?:"
    r"open|launch|search|google|look\s+up|play|watch|listen\s+to|put\s+on|pull\s+up|bring\s+up|"
    r"take\s+me\s+to|navigate\s+to|go\s+to|"
    r"(?:get|give\s+me|show\s+me)\s+(?:the\s+)?directions|directions\s+to|"
    r"show\s+(?:me\s+)?(?:.+\s+)?on\s+(?:the\s+|a\s+)?(?:map|maps|youtube|google)|"
    rf"(?:draft|compose|write|prepare|send|start)\s+{_MAIL}|"
    r"(?:e-?mail|mail)\s+(?!is\b|was\b|and\b)\w+"
    r")\b",
    re.IGNORECASE,
)
_SMALLTALK = re.compile(
    r"^(?:hi|hello|hey|yo|thanks|thank\s+you|cheers|bye|goodbye|good\s+(?:morning|afternoon|evening|night)|"
    r"how\s+are\s+you|what'?s\s+up|nice|cool|great|awesome|ok|okay|alright)\b",
    re.IGNORECASE,
)
_QUESTION = re.compile(
    r"^(?:how|what|what's|whats|why|who|whom|whose|when|where|which|is|are|was|were|do|does|did|"
    r"should|explain|describe|define|tell\s+me\s+(?:about|why|how|what))\b",
    re.IGNORECASE,
)
_TARGETS = re.compile(
    r"\b(?:youtube|google|browser|chrome|firefox|edge|safari|gmail|e-?mail|mail|maps?|directions|"
    r"website|site|calculator|notepad|text\s+editor|file\s+manager|terminal|settings)\b",
    re.IGNORECASE,
)
_AFFIRM = re.compile(
    r"^(?:yes|yeah|yep|yup|sure|ok|okay|please(?:\s+do)?|do\s+it|go\s+ahead|go\s+for\s+it|"
    r"sounds\s+good|absolutely|definitely|why\s+not|of\s+course)\b",
    re.IGNORECASE,
)
_OFFER = re.compile(
    r"\b(?:should\s+i|shall\s+i|want\s+me\s+to|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to|"
    r"i\s+can\s+(?:open|search|play|draft|show|pull))\b",
    re.IGNORECASE,
)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().strip("\"'")).strip()


def rule_route(text: str, last_assistant: str = "") -> tuple[str | None, str | None]:
    """(route, rule) from keyword rules; route is None when the rules have no opinion."""
    t = _normalize(text)
    words = len(t.split())
    if words <= 6 and _AFFIRM.match(t) and last_assistant.strip().endswith("?") and _OFFER.search(last_assistant):
        return "action", "follow-up"
    if _COMMAND.match(t):
        return "action", "command"
    if words <= 6 and _SMALLTALK.match(t):
        return "chat", "smalltalk"
    if _QUESTION.match(t) and not _TARGETS.search(t):
        return "chat", "question"
    return None, None


@dataclass
class RouteDecision:
    route: str
    decided_by: str
    confidence: float
    rule: str | None
    laya: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "route": self.route,
            "decided_by": self.decided_by,
            "confidence": round(self.confidence, 3),
            "rule": self.rule,
            "laya": self.laya,
        }


class LayaClient:
    def __init__(self, base_url: str, timeout_ms: int = 2500) -> None:
        self.base_url = base_url
        self._timeout = timeout_ms / 1000
        self._http = httpx.AsyncClient(base_url=base_url, timeout=self._timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def health(self) -> dict[str, Any]:
        try:
            res = await self._http.get("/health", timeout=2.0)
            res.raise_for_status()
            return {"ok": True}
        except httpx.HTTPError as exc:
            return {"ok": False, "error": str(exc) or type(exc).__name__}

    async def p_action(self, text: str, last_assistant: str, hints: list[str]) -> dict[str, Any]:
        state: dict[str, str] = {"user_request": text}
        # Context only helps when Gemma just asked something ("Want me to play it?").
        if last_assistant.strip().endswith("?"):
            state = {"assistant_said": last_assistant.strip()[-300:], "user_request": text}
        started = time.perf_counter()
        try:
            res = await self._http.post(
                "/v1/systemone",
                json={"state": state, "questions": route_questions(hints), "model": "english", "lang": "en"},
            )
            res.raise_for_status()
            answer = res.json()["answers"]["intent"]
            p = float(answer["probabilities"]["act"])
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            return {
                "ok": False,
                "error": str(exc) or type(exc).__name__,
                "latency_ms": round((time.perf_counter() - started) * 1000),
            }
        return {
            "ok": True,
            "p_action": round(p, 4),
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }


async def decide_route(
    laya: LayaClient,
    text: str,
    *,
    last_assistant: str = "",
    hints: list[str] | None = None,
    threshold: float = 0.5,
) -> RouteDecision:
    laya_info = await laya.p_action(text, last_assistant, hints or [])
    p = laya_info.get("p_action") if laya_info.get("ok") else None
    rule, rule_name = rule_route(text, last_assistant)

    if rule is not None:
        agrees = p is not None and (p >= threshold) == (rule == "action")
        confidence = (p if rule == "action" else 1 - p) if agrees and p is not None else 0.9
        return RouteDecision(rule, "laya" if agrees else "rules", confidence, rule_name, laya_info)
    if p is None:
        return RouteDecision("chat", "rules", 0.5, None, laya_info)
    route = "action" if p >= threshold else "chat"
    return RouteDecision(route, "laya", p if route == "action" else 1 - p, None, laya_info)
