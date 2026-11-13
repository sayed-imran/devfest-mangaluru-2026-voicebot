# Phase 03 — Voice in, text out (VAD + STT + Gemma 4)

Phase 02 turned your speech into text. Phase 03 sends that text to **Gemma 4 26B A4B on the DGX
Spark**, and Gemma's reply appears **as text only** in a chat window. Nothing is spoken back yet;
that is phase 04.

```
Mic → Silero VAD (browser) → WAV clip → Whisper (Spark :8001) → transcript ─┐
                                                                            ├→ Gemma 4 (Spark :8081) → text reply in chat
Keyboard (optional) ────────────────────────────────────────────────────────┘
```

Each spoken utterance becomes a user bubble tagged **voice**, holding the Whisper transcript.
Gemma's answer streams into the next bubble as text. You can also type, which helps when the
room is noisy, but voice is the main input.

This closes the loop from *listening* to *reasoning*, and the room's internet uplink can be
unplugged.

Demo-only panels from phases 01-02 (pipeline cards, event log, utterance clips, speech meter) are
gone. What remains is the conversation.

## Prerequisites

Nothing to run on your laptop besides the app. Check the Spark is reachable:

```bash
curl http://spark-065b.local:8081/v1/models
```

| Service | Where | Model |
| --- | --- | --- |
| Gemma 4 | `http://spark-065b.local:8081` (vLLM) | `gemma4-26b` |
| STT | `http://spark-065b.local:8001` (vLLM) | `whisper-large-v3-turbo` |

## App

```bash
cd phase-03
npm install                       # once, at the repo root: installs every phase
npm run dev
```

Open [http://localhost:3002](http://localhost:3002) (port **3002** so it can sit beside phases 01-02).

## Config

`.env.local`:

```bash
STT_BASE_URL=http://spark-065b.local:8001
STT_MODEL=whisper-large-v3-turbo
STT_LANGUAGE=en

LLM_BASE_URL=http://spark-065b.local:8081
LLM_MODEL=gemma4-26b
# optional:
# LLM_SYSTEM_PROMPT=You are Gemma...   # override the text-chat system prompt
```

Next.js proxies both backends, so the browser never talks to the Spark cross-origin:

- `POST /api/transcribe` → Whisper: WAV clip in, `{ text }` out
- `POST /api/chat` → Gemma 4: transcript in, text reply streamed back as SSE

## How to use

1. **Voice (the main path):** click **Mic**, ask a question, pause. VAD ends the utterance,
   Whisper turns it into a user bubble, and Gemma's reply streams in as text.
2. **Text:** type in the composer and press **Send**. Same history, same model.
3. **Barge-in:** while Gemma is replying, a new utterance or typed message stops the stream and
   starts a fresh turn. Empty or noise-only transcripts do not interrupt.

## Unplug the cable

Do this literally, in front of the room. Pull the Spark's internet uplink and keep talking.
Nothing changes. That is the thesis of the workshop, and it takes five seconds to show.

## Try this

- Change the system prompt through `LLM_SYSTEM_PROMPT` and restart the dev server.
- Mispronounce a word on purpose. The prompt tells Gemma that input comes from speech
  recognition, so it usually recovers the meaning anyway.
- Ask the whole room to send a message at the same moment, and watch time-to-first-token go up.
  One model is serving everyone. The [finale](../finale.md) measures this properly.

## Workshop talking points

1. Phases 01-02 were building blocks; this is the assistant.
2. Speech is only an input format here: once Whisper has produced text, Gemma never knows the
   user spoke. Voice and typed turns share one history and one model path.
3. Streaming matters for feel: tokens appear as Gemma generates them, and TTFT is what the user
   actually experiences as "is it working?".
4. One box in the room serves everyone. No API key, no quota, no egress.
5. The reply is text only. Next phase gives it a voice.
