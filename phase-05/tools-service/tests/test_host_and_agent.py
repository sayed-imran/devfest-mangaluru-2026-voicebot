import asyncio
import json
from types import SimpleNamespace

from gemma_tools.agent import run_agent
from gemma_tools.llm import AssistantTurn, ToolCall
from gemma_tools.mcp_host import MCPHost, ServerConfig, llm_schema, load_server_configs, to_outcome


def test_llm_schema_simplifies_pydantic_output():
    schema = {
        "type": "object",
        "title": "argsModel",
        "$defs": {"Mode": {"enum": ["a", "b"], "title": "Mode", "type": "string"}},
        "properties": {
            "title": {"title": "Title", "type": "string", "description": "a property literally called title"},
            "cc": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None, "title": "Cc"},
            "mode": {"$ref": "#/$defs/Mode"},
        },
        "required": ["title"],
    }
    assert llm_schema(schema) == {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "a property literally called title"},
            "cc": {"default": None, "type": "string", "nullable": True},
            "mode": {"enum": ["a", "b"], "type": "string"},
        },
        "required": ["title"],
    }


def test_config_file_and_disabled_servers(tmp_path):
    path = tmp_path / "servers.json"
    path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "desktop": {"builtin": "desktop", "fastConfirm": True},
                    "off": {"disabled": True, "command": "npx"},
                    "broken": {"description": "no transport"},
                    "remote": {"url": "http://127.0.0.1:9/mcp"},
                }
            }
        )
    )
    configs = load_server_configs(path)
    assert [(c.name, c.transport) for c in configs] == [("desktop", "in-process"), ("remote", "http")]
    assert load_server_configs(tmp_path / "missing.json")[0].builtin == "desktop"


def test_error_results_lose_the_sdk_prefix():
    result = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="Error executing tool play_youtube: What should I play?")],
        structured_content=None,
        is_error=True,
    )
    outcome = to_outcome(result)
    assert not outcome.ok and outcome.message == "What should I play?"


async def _host() -> MCPHost:
    host = MCPHost([ServerConfig(name="desktop", builtin="desktop", fast_confirm=True)])
    await host.start()
    return host


def test_builtin_desktop_server_through_mcp():
    async def scenario():
        host = await _host()
        try:
            names = {t.name for t in host.tools}
            assert {"open_browser", "search_youtube", "play_youtube", "draft_email", "open_app"} <= names
            ok = await host.call_tool("search_youtube", {"query": "lofi"})
            assert ok.ok and ok.data["dry_run"] and ok.message.startswith("I've opened YouTube results for lofi")
            bad = await host.call_tool("open_app", {"app": "powershell"})
            assert not bad.ok
            missing = await host.call_tool("does_not_exist", {})
            assert not missing.ok
            assert all(t["function"]["parameters"]["type"] == "object" for t in host.openai_tools())
        finally:
            await host.stop()

    asyncio.run(scenario())


class ScriptedLLM:
    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = []

    async def chat(self, messages, tools=None, max_tokens=0, temperature=0.0):
        self.calls.append({"messages": messages, "tools": tools})
        return self.turns.pop(0)


def test_agent_fast_confirm_skips_second_llm_call():
    async def scenario():
        host = await _host()
        try:
            llm = ScriptedLLM([AssistantTurn("", [ToolCall("c1", "search_youtube", {"query": "lofi"})])])
            events = [
                e
                async for e in run_agent(
                    host=host, llm=llm, messages=[{"role": "user", "content": "search youtube for lofi"}],
                    os_name="TestOS",
                )
            ]
            assert [e["type"] for e in events] == ["tool_call", "tool_result", "final"]
            assert events[-1]["fast"] and "YouTube results for lofi" in events[-1]["text"]
            assert len(llm.calls) == 1
            assert "TestOS" in llm.calls[0]["messages"][0]["content"]
        finally:
            await host.stop()

    asyncio.run(scenario())


def test_agent_reports_failures_back_to_the_llm():
    async def scenario():
        host = await _host()
        try:
            llm = ScriptedLLM(
                [
                    AssistantTurn("", [ToolCall("c1", "play_youtube", {"query": ""})]),
                    AssistantTurn("What would you like me to play?"),
                ]
            )
            events = [
                e
                async for e in run_agent(
                    host=host, llm=llm, messages=[{"role": "user", "content": "play something"}], os_name="TestOS"
                )
            ]
            result = next(e for e in events if e["type"] == "tool_result")
            assert result["ok"] is False and result["message"] == "What should I play?"
            assert events[-1] == {
                "type": "final",
                "text": "What would you like me to play?",
                "actions": events[-1]["actions"],
                "steps": 2,
            }
            tool_message = llm.calls[1]["messages"][-1]
            assert tool_message["role"] == "tool" and tool_message["tool_call_id"] == "c1"
        finally:
            await host.stop()

    asyncio.run(scenario())


def test_agent_answers_without_tools():
    async def scenario():
        host = await _host()
        try:
            llm = ScriptedLLM([AssistantTurn("I'm doing well, thanks!")])
            events = [
                e
                async for e in run_agent(
                    host=host, llm=llm, messages=[{"role": "user", "content": "how are you?"}], os_name="TestOS"
                )
            ]
            assert events == [{"type": "final", "text": "I'm doing well, thanks!", "actions": [], "steps": 1}]
        finally:
            await host.stop()

    asyncio.run(scenario())
