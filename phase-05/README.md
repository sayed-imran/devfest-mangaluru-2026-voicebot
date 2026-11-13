# Phase 05 — Tools (Laya routing + Gemma tool calls + MCP)

Gemma **does things**: opens the browser, searches Google or YouTube, plays a video, drafts an
email, shows maps and directions, opens a few desktop apps. Everything from phase 04 (VAD, STT,
Gemma 4, Kokoro, speak vs handoff) still works the same.

Actions are performed by a **Python FastAPI tools service** that hosts MCP servers. The browser
never opens anything itself; the Next.js server asks the tools service, and the tools service acts
on the computer it runs on (Windows, macOS or Linux).

```
Mic / text → STT → Next.js /api/partition
                      │
                      ├─ tools-service /v1/route ── Laya: action or chat?  (~0.2 s)
                      │
         action ──────┤                        chat ──→ Laya: speak vs handoff → Gemma (phase 04)
                      ↓
         /api/agent → tools-service /v1/agent
                      Gemma 4 picks tools ─→ MCP (built-in desktop server, or any MCP server)
                                           ─→ opens browser / YouTube / Gmail draft / maps / app
                      ↓
         one-line confirmation → Kokoro speaks it, tool activity shows in chat
```

## Where things run

Every model is on the Spark. The tools service is the one Python process on your laptop, and it
holds no model: it opens things on your screen and calls Gemma and Laya over the LAN.

| What | Where | Port |
| --- | --- | --- |
| Gemma 4 26B A4B (vLLM, tool calling) | Spark | 8081 |
| Whisper (vLLM) | Spark | 8001 |
| Kokoro TTS, Laya | Spark | 8880, 8002 |
| Tools service (no model) | your laptop | 8765 |
| Web app | your laptop | 3004 |

The tools service has to run on the computer whose screen should show the browser. It cannot open
windows on the Spark, and `/health` reports that.

## 1. Tool calling on the Spark

The Spark runs vLLM with `--enable-auto-tool-choice --tool-call-parser gemma4`
([../spark/docker-compose.yml](../spark/docker-compose.yml)), so Gemma's tool calls come back as
structured `tool_calls`. If a server leaves Gemma's native `<|tool_call>call:name{…}<tool_call|>`
text in the message body instead, the tools service parses that too (`gemma_tools/llm.py`).

## 2. Tools service

Needs Python 3.10+ ([python.org](https://www.python.org/downloads/); macOS's built-in `python3`
is often 3.9).

```bash
cd phase-05/tools-service
cp .env.example .env          # Windows: copy .env.example .env
# edit .env if spark-065b.local does not resolve: use the Spark's IP
```

| OS | Start |
| --- | --- |
| Windows (cmd or PowerShell) | `start.cmd` |
| macOS / Linux | `./start.sh` |
| Any (manual) | `python -m venv .venv`, install `requirements.txt`, then `.venv/bin/python -m gemma_tools` (Windows: `.venv\Scripts\python -m gemma_tools`) |

The scripts create `.venv` on first run, install requirements and start on
`http://127.0.0.1:8765`. Useful flags: `--dry-run` (describe actions, open nothing), `--check`
(can this computer open windows?).

```bash
curl http://127.0.0.1:8765/health          # MCP servers, tool count, LLM + Laya reachability, desktop status
curl http://127.0.0.1:8765/v1/tools
curl -X POST http://127.0.0.1:8765/v1/route -H 'Content-Type: application/json' -d '{"text":"play lofi on youtube"}'
curl -X POST http://127.0.0.1:8765/v1/agent -H 'Content-Type: application/json' \
  -d '{"stream":false,"messages":[{"role":"user","content":"search youtube for lofi hip hop"}]}'
```

Interactive API docs: `http://127.0.0.1:8765/docs`.

## 3. Web app

```bash
cd phase-05
npm install                       # once, at the repo root: installs every phase
npm run dev
```

Open [http://localhost:3004](http://localhost:3004) (localhost keeps the mic allowed). The header
shows **Tools online** plus the OS it will act on.

## Tools (built-in MCP server `desktop`)

| Tool | Example request |
| --- | --- |
| `open_browser` | "Open the browser" |
| `open_website` | "Take me to GitHub", "open bbc.co.uk" |
| `web_search` | "Google the weather in Bangalore" |
| `open_youtube` | "Open YouTube" |
| `search_youtube` | "Search YouTube for lofi hip hop" |
| `play_youtube` | "Play Despacito" — finds the top video and starts it |
| `draft_email` | "Draft a mail to my manager saying I'll be late" — Gmail compose by default; never sends |
| `show_on_map` / `get_directions` | "Show coffee near me", "Directions to the airport by train" |
| `open_app` | Calculator, text editor, file manager, terminal, system settings (allow-list only) |

Per OS: Windows uses the registry's default browser and the shell; macOS uses `open`; Linux uses
`xdg-open`/`gio` and finds your desktop session even when the service was started over SSH. Apps
are launched detached, so they stay open if the service stops.

The same server also runs standalone for other MCP clients: `python -m gemma_tools.desktop` (stdio).

## How a turn is decided

1. **Action or chat** — one Laya `choice` question (`act` vs `talk`) in a single forward pass
   (~180 ms on CPU). When Gemma just asked something ("Want me to play it?"), its question is
   included so "yes, go ahead" counts as an action.
2. Keyword rules back Laya up: obvious commands ("open…", "search…", "draft an email…") are always
   actions, greetings and plain questions stay chat, and routing keeps working if Laya is down.
   `/v1/route` returns the decision, Laya's P(action), and whether Laya or the rules made it.
3. **Action** → Gemma gets the MCP tools; tool results go back through MCP. If every tool came
   from the desktop server and succeeded, Gemma speaks the tools' own confirmation instead of a
   second model call (saves ~1 s).
4. **Chat** → phase 04 unchanged.

If the tools service is off or unreachable, every turn is chat (phase 04 behaviour).

## A note on quantization and tool calls

Quantization breaks tool arguments first. Chat degrades gracefully, but strict JSON does not. The
Spark serves the 26B at FP8, which holds up. If you see malformed arguments after someone lowers
the precision, the quantization is the cause, not the agent. [../spark/models.md](../spark/models.md)
has the numbers.

## Config

`tools-service/.env` (see `.env.example`):

```bash
TOOLS_HOST=127.0.0.1             # anything else requires TOOLS_API_KEY
TOOLS_PORT=8765
TOOLS_API_KEY=
LLM_BASE_URL=http://spark-065b.local:8081
LLM_MODEL=gemma4-26b
LAYA_BASE_URL=http://spark-065b.local:8002
TOOLS_ROUTE_THRESHOLD=0.5        # Laya P(action) for an action turn
TOOLS_BROWSER=default            # default | chrome | edge | firefox | brave | safari
TOOLS_SEARCH_ENGINE=google       # google | bing | duckduckgo
TOOLS_MAIL_CLIENT=gmail          # gmail | outlook | outlook-personal | mailto
TOOLS_GMAIL_ACCOUNT=             # which signed-in Gmail account opens drafts
TOOLS_USER_NAME=                 # signs email drafts
TOOLS_DRY_RUN=0
```

`.env.local` (app) adds:

```bash
TOOLS_BASE_URL=http://127.0.0.1:8765   # empty = chat only
TOOLS_API_KEY=                         # same value as the tools service
TOOLS_TIMEOUT_MS=4000
```

## More MCP servers

`tools-service/mcp_servers.json` uses the familiar `mcpServers` format. Each entry is `builtin`, a
stdio `command` + `args` (+ `env`), or a streamable-HTTP `url` (+ `headers`). `"disabled": true`
skips it, `routeHint` adds its abilities to Laya's "action" description, and `fastConfirm` lets its
results be spoken directly. A Playwright example is included (disabled); `"command": "python"`
means the service's own interpreter.

## Security

- Listens on `127.0.0.1` only by default; binding elsewhere refuses to start without `TOOLS_API_KEY`.
- Without a key, only `localhost` Host headers are accepted (blocks DNS-rebinding from web pages).
- Only `http(s)` links and email drafts can be opened; apps come from a fixed allow-list; emails
  are drafts, never sends.

A voice agent with a shell is a voice agent anyone within earshot can drive. Guard rails are not
optional here, and the allow-list is the interesting design decision in this phase.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "There's no logged-in desktop…" | The tools service is on a headless machine (or one at its login screen). Run it on the computer you're using. |
| Tools offline in the header | Start the tools service; check `TOOLS_BASE_URL`. Chat keeps working meanwhile. |
| Gemma replies with `<\|tool_call>` text in chat | The tools service parses that form, so this means the turn went down the plain chat path. Check `/v1/route`. |
| Malformed tool arguments | Quantized too far. See the note above. |
| `LLM unreachable` in `/health` | `LLM_BASE_URL` in `tools-service/.env` must point at the Spark, not localhost. |
| macOS: "Python 3.10+ is required" | Install Python from python.org or Homebrew, or `PYTHON=python3.12 ./start.sh`. |
| Test without opening anything | `start.sh --dry-run` / `start.cmd --dry-run`; replies end with "(Dry run…)". |

Tests: `.venv/bin/python -m pip install pytest && .venv/bin/python -m pytest`
(Windows: `.venv\Scripts\python -m pytest`).

## Workshop talking points

1. System 1 vs System 2: Laya decides *whether* to act in ~0.2 s; Gemma decides *which* tool and
   with what arguments.
2. MCP turns tools into plug-ins — the built-in server and third-party servers look identical to
   the agent, which is what makes the tool layer portable across runtimes.
3. Actions belong on the server the user trusts, not in browser JavaScript.
4. Cross-platform is mostly about launching: registry vs `open` vs `xdg-open`, detached processes,
   and finding the desktop session.
