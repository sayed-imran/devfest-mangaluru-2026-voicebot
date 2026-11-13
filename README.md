# Hey Gemma, No Internet

**Building voice agents that never phone home.**
Workshop repo for DevFest Mangaluru 2026 — Sayed Imran, SRE at 66degrees.

Most voice assistants are a microphone with a long cable to someone else's datacentre. This
workshop builds the opposite: a voice agent that hears you, reasons, calls real functions and
answers, with the network cable unplugged.

Every model runs on one **NVIDIA DGX Spark** on the room's local network: Gemma 4 26B A4B and
Whisper served by [vLLM](https://github.com/vllm-project/vllm), plus Kokoro TTS and Laya.
Attendee laptops download no weights and run no inference. They run a small Next.js app that
talks to the Spark over the LAN, and the room's internet uplink can be unplugged throughout.
Setup for the box itself: [spark/README.md](spark/README.md).

## Phases

Each phase is a complete, runnable app. Start at 01 and work up; each one adds a single stage of
the pipeline and has its own README.

| Phase | Adds | Port | Your laptop runs |
| --- | --- | --- | --- |
| [01](phase-01/) | Silero VAD in the browser | 3000 | the app |
| [02](phase-02/) | Speech to text (Whisper on the Spark) | 3001 | the app |
| [03](phase-03/) | Voice in, text out: transcript → Gemma 4 → text reply | 3002 | the app |
| [04](phase-04/) | Kokoro TTS, barge-in, speak vs handoff | 3003 | the app |
| [05](phase-05/) | Function calling and MCP tools | 3004 | the app + tools service (no model) |
| [Finale](finale.md) | One box, the whole room: live load test and benchmarks | — | nothing new (presenter-led) |

By the end of phase 03 you can ask Gemma a question out loud and read its answer. Phase 04 makes it
answer out loud. That is the first half hour. Phase 05 makes the agent *do* things, and the finale
measures what one shared box does for the whole room.

```
Mic ─▶ Silero VAD ─▶ speech to text ─▶ Gemma 4 ─▶ tools (MCP) ─▶ Kokoro ─▶ speaker
       phase 01       phase 02          phase 03    phase 05      phase 04
       │              │                 │           │             │
       browser        └──── DGX Spark on the LAN ───┼─────────────┘
                                                    └─ actions run on your laptop
```

## Before the workshop

**Fastest:** follow <https://sayed-imran.github.io/devfest-mangaluru-2026-voicebot/>. One command installs
nvm + Node, Python, clones this repo and does all the downloads below:

```bash
curl -fsSL https://sayed-imran.github.io/devfest-mangaluru-2026-voicebot/setup.sh | bash       # macOS / Linux / WSL
```
```powershell
powershell -ExecutionPolicy Bypass -c "irm https://sayed-imran.github.io/devfest-mangaluru-2026-voicebot/setup.ps1 | iex"   # Windows
```

Or by hand:

1. **Node 20+**. Add **Python 3.10+** if you want to do phase 05 (tools).
2. **Clone and run `npm install` once at the repo root, on wifi, beforehand.** That is the only download.
   The phases are npm workspaces, so this single install fills one shared `node_modules` for all five.
   ```bash
   npm install
   ```
   For phase 05, also run `phase-05/tools-service/start.sh` (Windows: `start.cmd`) once on wifi,
   so it can install its Python packages.
3. **Headphones.** Thirty laptops all speaking out loud is not a pleasant room, and barge-in will
   hear your neighbour.

No Docker, no model downloads, no GPU. The presenter brings the Spark.

## Quick start

```bash
cd phase-03
npm run dev                       # http://localhost:3002
```

Or from the repo root: `npm run dev:03` (likewise `dev:01` … `dev:05`).

Allow the microphone and start talking. The header shows each service on the Spark going green
as it connects. If `spark-065b.local` doesn't resolve on the room network, replace it with the IP on the
slide in that phase's `.env.local`.

## Repo layout

| Path | What |
| --- | --- |
| `phase-01` … `phase-05` | The workshop, one runnable app per stage |
| `finale.md` | Presenter-led closing: measuring the shared Spark under the room's load |
| `spark/` | Everything that runs on the DGX Spark: docker compose, smoke test, sizing, model notes |
| `bench/` | TTFT / decode / prefill harness, with `--concurrency` to simulate the room |
| `phase-05/tools-service` | Python FastAPI service hosting MCP servers |

## Why Gemma 4 26B A4B

The 26B is a Mixture-of-Experts model with only 3.8B parameters active per token. It decodes
roughly as fast as a 4B dense model while having the knowledge and tool-calling quality of a much
bigger one. Served at FP8 with vLLM's continuous batching, one Spark can carry the whole room.
It has no audio input, which is why Whisper does the transcription. Sizes and quantization
trade-offs: [spark/models.md](spark/models.md).

## Things worth arguing about

The workshop is built around four claims. Each has a phase that tests it.

1. **Audio should not leave the building by default.** Phases 01-03. "Local" is a network
   boundary. Sovereignty is the easy argument; latency is the one that actually changes the
   product.
2. **Not every stage collapses into one model.** Phase 02. Multimodal models can transcribe, but
   the model size that suits a shared box (26B) doesn't take audio, so a dedicated Whisper earns its
   place.
3. **A voice agent that only talks is a demo, not a tool.** Phase 05. Function calling and MCP.
4. **One on-prem box can serve a room.** The [finale](finale.md) plus `bench/`. Bring numbers, not opinions.

## Credits

Built on [vLLM](https://github.com/vllm-project/vllm) and
[Gemma 4](https://ai.google.dev/gemma) (Apache 2.0),
[Silero VAD](https://github.com/snakers4/silero-vad) via
[`@ricky0123/vad-web`](https://github.com/ricky0123/vad),
[Kokoro](https://github.com/remsky/Kokoro-FastAPI),
[Whisper](https://github.com/openai/whisper),
[Laya](https://github.com/NandhaKishorM/laya), the
[Model Context Protocol](https://modelcontextprotocol.io), and the

An earlier version of this workshop ran at Open Source India 2026 as *The Open Source Jarvis*:
[sayed-imran/open-source-india-voicebot](https://github.com/sayed-imran/open-source-india-voicebot).
