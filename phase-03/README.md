# Phase 03 — Chat (VAD + STT + Gemma 4 on LiteRT-LM)

The product surface: a **chat UI** where you can type or talk. Silero VAD segments speech in the
browser, phase 02's STT turns it into text, and **Gemma 4 running locally through LiteRT-LM**
streams the reply.

This is the end of the first half hour. At this point the loop is closed and the network cable
can come out.

```
Mic → Silero VAD (browser) → WAV → STT ─┐
                                        ├→ Gemma 4 via LiteRT-LM (:8081) → chat bubble
Keyboard / text box ────────────────────┘
```

Demo-only panels from phases 01-02 (pipeline cards, event log, utterance clips, speech meter) are
gone. What remains is the conversation.

## Prerequisites

One terminal, one command, no GPU required:

```bash
./litert/serve.sh          # Gemma 4 E4B on http://127.0.0.1:8081
curl http://127.0.0.1:8081/v1/models
```

| Service | Where | Model |
| --- | --- | --- |
| Gemma 4 | `http://127.0.0.1:8081` | `gemma4-e4b` |
| STT | same server (`STT_MODE=gemma`) | `gemma4-e4b` |

If you prefer Whisper for STT, see [phase-02](../phase-02/README.md) and set `STT_MODE=whisper`.

## App

```bash
cd phase-03
npm install
npm run dev
```

Open [http://localhost:3002](http://localhost:3002) (port **3002** so it can sit beside phases 01-02).

## Config

`.env.local`:

```bash
STT_MODE=gemma
STT_GEMMA_BASE_URL=http://127.0.0.1:8081
STT_GEMMA_MODEL=gemma4-e4b
STT_LANGUAGE=en

LLM_BASE_URL=http://127.0.0.1:8081
LLM_MODEL=gemma4-e4b
# optional:
# LLM_SYSTEM_PROMPT_SPEAK=You are Gemma...
```

Next.js proxies both backends so the browser never talks to `:8081` cross-origin:

- `POST /api/transcribe` → STT
- `POST /api/chat` → Gemma 4, streamed as SSE

Note that both point at the **same** base URL. One server, one model, two jobs.

## How to use

1. **Text:** type in the composer and press **Send**.
2. **Voice:** click **Mic**, speak, pause — VAD ends the utterance, STT fills a user bubble, then
   Gemma streams a reply.
3. **Barge-in:** while Gemma is replying, a new typed message or a meaningful transcript aborts the
   stream and starts a fresh turn. Empty or noise-only transcripts do not interrupt.

## Unplug the cable

Worth doing literally, in front of the room. Turn off wifi, keep talking. Nothing changes. That is
the entire thesis of the workshop and it takes five seconds to demonstrate.

## Tuning

`~/.litert-lm/config.json` is where the interesting knobs live — backend, thread count, context
length, speculative decoding. See [../litert/README.md](../litert/README.md#4-configuration).

Two worth trying live:

- `"backend": "gpu"` versus `"cpu"` on the same machine. Then run `bench/bench.py` on both and
  watch the decode rate move.
- Drop to `gemma4-e2b`. It is noticeably less clever and noticeably faster. Where that trade sits
  for your own product is the real question.

## Workshop talking points

1. Phases 01-02 were building blocks; this is the assistant.
2. Voice and text share one message history and one model path.
3. Streaming matters for feel: tokens appear as Gemma generates them, and TTFT is what the user
   actually experiences as "is it working?".
4. The whole thing is one process on a laptop. No API key, no quota, no egress.
5. Next phase gives it a voice.
