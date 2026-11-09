"""Tool loop: Gemma picks tools, MCP servers run them, Gemma confirms in one spoken line."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from .llm import AssistantTurn, LLMClient
from .mcp_host import MCPHost, ToolEntry, ToolOutcome

log = logging.getLogger("gemma_tools.agent")

MAX_HISTORY_MESSAGES = 16


def system_prompt(os_name: str, user_name: str = "") -> str:
    now = datetime.now().astimezone().strftime("%A %d %B %Y, %H:%M %Z")
    signature = (
        f"Sign emails as {user_name}."
        if user_name
        else "End emails with a sign-off but no name, since you don't know the user's name."
    )
    return "\n".join(
        [
            "You are Gemma, a helpful open-source voice assistant that can act on the user's computer through tools.",
            f"The user's computer runs {os_name}. Local time: {now}.",
            "- When the user asks to open something, search the web or YouTube, play something, show a place or "
            "directions, open an app, or draft an email, call the matching tool. One request may need several tools.",
            "- Never claim you did something unless a tool result says it worked. If a tool fails, say so briefly.",
            "- Emails are drafts only; you cannot send them. Write a complete, natural subject and body yourself. "
            "Never use placeholders like [Name] or [Time]; leave unknown details out. Put only real email addresses "
            f"in 'to'; if the user named someone without an address, leave 'to' empty. {signature}",
            "- If something essential is missing (for example what to search for), ask one short question instead.",
            "- If no tool fits, simply answer.",
            "- Your reply is spoken aloud: one or two short sentences, no lists, no URLs, no markdown.",
        ]
    )


def _sanitize_history(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    clean: list[dict[str, str]] = []
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        clean.append({"role": role, "content": content.strip()})
    return clean[-MAX_HISTORY_MESSAGES:]


def _action_event(entry: ToolEntry | None, call_id: str, name: str, outcome: ToolOutcome) -> dict[str, Any]:
    data = outcome.data or {}
    return {
        "type": "tool_result",
        "id": call_id,
        "name": name,
        "title": entry.title if entry else name,
        "ok": outcome.ok,
        "message": outcome.message,
        "url": data.get("url"),
        "dry_run": bool(data.get("dry_run", False)),
    }


def _fast_confirmation(results: list[tuple[ToolEntry | None, ToolOutcome]]) -> str | None:
    """Speak the tools' own confirmations when every call came from a fast-confirm server and worked."""
    if not results or not all(entry and entry.fast_confirm and outcome.ok for entry, outcome in results):
        return None
    lines: list[str] = []
    for _, outcome in results:
        if outcome.message and outcome.message not in lines:
            lines.append(outcome.message)
    if any((outcome.data or {}).get("dry_run") for _, outcome in results):
        lines.append("(Dry run: nothing was actually opened.)")
    return " ".join(lines) or None


async def run_agent(
    *,
    host: MCPHost,
    llm: LLMClient,
    messages: list[dict[str, Any]],
    os_name: str,
    user_name: str = "",
    max_steps: int = 4,
    fast_confirm: bool = True,
) -> AsyncIterator[dict[str, Any]]:
    """Yields `tool_call`, `tool_result` and finally one `final` (or `error`) event."""
    history = _sanitize_history(messages)
    if not history or history[-1]["role"] != "user":
        yield {"type": "error", "message": "The last message must be from the user."}
        return

    convo: list[dict[str, Any]] = [{"role": "system", "content": system_prompt(os_name, user_name)}, *history]
    tools = host.openai_tools()
    actions: list[dict[str, Any]] = []

    for step in range(max_steps):
        turn: AssistantTurn = await llm.chat(convo, tools=tools or None, max_tokens=900)
        if not turn.tool_calls:
            text = turn.text or "Sorry, I didn't catch that. Could you say it again?"
            yield {"type": "final", "text": text, "actions": actions, "steps": step + 1}
            return

        convo.append(
            {
                "role": "assistant",
                "content": turn.text or None,
                "tool_calls": [call.as_message_part() for call in turn.tool_calls],
            }
        )
        results: list[tuple[ToolEntry | None, ToolOutcome]] = []
        for call in turn.tool_calls:
            entry = host.get(call.name)
            yield {
                "type": "tool_call",
                "id": call.id,
                "name": call.name,
                "title": entry.title if entry else call.name,
                "arguments": call.arguments,
            }
            outcome = await host.call_tool(call.name, call.arguments)
            log.info("tool %s(%s) -> %s", call.name, json.dumps(call.arguments)[:200], outcome.message)
            event = _action_event(entry, call.id, call.name, outcome)
            actions.append({**event, "arguments": call.arguments})
            yield event
            convo.append({"role": "tool", "tool_call_id": call.id, "content": outcome.text})
            results.append((entry, outcome))

        if fast_confirm:
            spoken = _fast_confirmation(results)
            if spoken:
                yield {"type": "final", "text": spoken, "actions": actions, "steps": step + 1, "fast": True}
                return

    turn = await llm.chat(convo, max_tokens=160)
    text = turn.text or "I ran out of steps before finishing that."
    yield {"type": "final", "text": text, "actions": actions, "steps": max_steps}
