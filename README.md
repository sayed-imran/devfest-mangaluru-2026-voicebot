# Hey Gemma, No Internet

**Building voice agents that never phone home.**
Workshop repo for DevFest Mangaluru 2026 — Sayed Imran, SRE at 66degrees.

Most voice assistants are a microphone with a long cable to someone else's datacentre. This
workshop builds the opposite: a voice agent that hears you, reasons, calls real functions and
answers, with the network cable unplugged.

Everything runs on your own laptop through [LiteRT-LM](litert/README.md), Google AI Edge's
on-device inference engine, serving Gemma 4. In the last phase the same client points at an
NVIDIA DGX Spark on the room's network running the 26B model, still entirely offline, so you can
see what changes when the model is a shared appliance instead of a process on your machine.

## Phases

Each phase is a complete, runnable app. Start at 01 and work up; each one adds a single stage of
the pipeline and has its own README.

| Phase | Adds | Port | Needs |
| --- | --- | --- | --- |
| [01](phase-01/) | Silero VAD in the browser | 3000 | nothing |
| [02](phase-02/) | Speech to text | 3001 | LiteRT-LM |
| [03](phase-03/) | Gemma 4 reasoning — the loop closes | 3002 | LiteRT-LM |
| [04](phase-04/) | Kokoro TTS, barge-in, speak vs handoff | 3003 | LiteRT-LM + docker |
| [05](phase-05/) | Function calling and MCP tools | 3004 | + tools service |
| [06](phase-06/) | Same client, DGX Spark endpoint, benchmarks | 3005 | + the Spark |

By the end of phase 03 you have a working speech-to-reasoning-to-speech loop. That is the first
half hour. Everything after it is about making the agent *do* things, and about where the work
should run.

```
Mic ─▶ Silero VAD ─▶ speech to text ─▶ Gemma 4 ─▶ tools (MCP) ─▶ Kokoro ─▶ speaker
       phase 01       phase 02          phase 03    phase 05      phase 04
                      │                 │
                      └─ LiteRT-LM ─────┴── laptop (phases 02-05) or DGX Spark (phase 06)
```

## Before the workshop

1. **Node 20+** and **Python 3.10+**.
2. **LiteRT-LM** with a model pulled, which is the slow part. Do this on wifi beforehand:
   ```bash
   uv tool install litert-lm
   litert-lm import --from-huggingface-repo=litert-community/gemma-4-E4B-it-litert-lm \
     gemma-4-E4B-it.litertlm gemma4-e4b
   ```
3. **Docker** (phase 04 onward, for Kokoro).
4. **Headphones.** Thirty laptops all speaking out loud is not a pleasant room.
5. About **8GB of free RAM** and ~6GB of disk.

Full detail in [litert/README.md](litert/README.md).

## Quick start

```bash
# terminal 1 — the model
./litert/serve.sh                 # Gemma 4 E4B on http://127.0.0.1:8081

# terminal 2 — the app
cd phase-03
npm install                       # also copies Silero / ONNX assets into public/vad
npm run dev                       # http://localhost:3002
```

Allow the microphone and start talking. The header shows each service going green as it connects.

## Repo layout

| Path | What |
| --- | --- |
| `phase-01` … `phase-06` | The workshop, one runnable app per stage |
| `litert/` | LiteRT-LM setup, serve scripts, model and quantization reference |
| `bench/` | Prefill / decode / TTFT harness for the Pi vs laptop vs Spark comparison |
| `phase-05/tools-service`, `phase-06/tools-service` | Python FastAPI service hosting MCP servers |

## Choosing a model size

| You have | Model | Alias | ~4-bit footprint |
| --- | --- | --- | --- |
| Raspberry Pi, phone, 8GB laptop | Gemma 4 E2B | `gemma4-e2b` | 2.9 GB (1.1 GB QAT) |
| Ordinary laptop | Gemma 4 E4B | `gemma4-e4b` | 4.5 GB (2.5 GB QAT) |
| 16GB GPU or unified memory | Gemma 4 12B Unified | `gemma4-12b` | 6.7 GB |
| DGX Spark, 128GB unified | Gemma 4 26B A4B | `gemma4-26b` | 14.4 GB |

The 26B is a Mixture-of-Experts model with only 3.8B parameters active per token, so it decodes
roughly as fast as a 4B dense model while occupying memory closer to a dense 26B. Full table and
the real cost of quantization: [litert/models.md](litert/models.md).

## Things worth arguing about

The workshop is built around four claims. Each has a phase that tests it.

1. **Audio should not leave the device by default.** Phase 01-03. Sovereignty is the easy argument;
   latency is the one that actually changes the product.
2. **Speech to text is no longer a separate model.** Phase 02. Gemma 4 E2B and E4B take audio
   natively, so `STT_MODE=gemma` removes a whole service from the diagram. Whisper is still there
   under `STT_MODE=whisper` for comparison.
3. **A voice agent that only talks is a demo, not a tool.** Phase 05. Function calling and MCP.
4. **On-device, on-prem and cloud each win somewhere.** Phase 06 plus `bench/`. Bring numbers, not
   opinions.

## Credits

Built on [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) and
[Gemma 4](https://ai.google.dev/gemma) (Apache 2.0),
[Silero VAD](https://github.com/snakers4/silero-vad) via
[`@ricky0123/vad-web`](https://github.com/ricky0123/vad),
[Kokoro](https://github.com/remsky/Kokoro-FastAPI),
[Whisper](https://github.com/openai/whisper),
[Laya](https://github.com/NandhaKishorM/laya) and the
[Model Context Protocol](https://modelcontextprotocol.io).

An earlier version of this workshop ran at Open Source India 2026 as *The Open Source Jarvis*,
with vLLM in place of LiteRT-LM:
[sayed-imran/open-source-india-voicebot](https://github.com/sayed-imran/open-source-india-voicebot).
