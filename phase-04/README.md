# Phase 04 — Voice replies (VAD + STT + Gemma 4 + TTS)

Gemma **talks back**, and learns to be interrupted.
[Laya](https://github.com/NandhaKishorM/laya) decides whether a reply should be fully spoken or
only announced ("detailed answer is in the chat"). Short spoken answers use Kokoro with
word-synced chat text; handoffs put the full write-up on screen.

```
Mic → Silero VAD → STT ─┐
Text box ───────────────┤
                        ├→ Gemma 4 on the Spark (:8081) → reply
                        │
     Laya (:8002) on user intent → speak vs handoff
                        │
     speak-all ──→ short Gemma reply → Kokoro (:8880) speaks it
     handoff ────→ speak a short cue *while* the full answer streams to chat
```

## Prerequisites

Kokoro and Laya join Gemma and Whisper on the Spark. Your laptop still runs only the app, with
no Docker and no model downloads.

| Service | Where | Port | Notes |
| --- | --- | --- | --- |
| Gemma 4 26B A4B | Spark, vLLM | 8081 | |
| Whisper | Spark, vLLM | 8001 | |
| Kokoro TTS | Spark | 8880 | 82M params |
| Laya | Spark | 8002 | optional, CPU on purpose |

Health checks from your laptop:

```bash
curl http://spark-065b.local:8880/v1/audio/voices   # TTS web UI: http://spark-065b.local:8880/web/
curl http://spark-065b.local:8002/health
```

Laya is optional. If `LAYA_BASE_URL` is empty, a word-count heuristic takes over.

## App

```bash
cd phase-04
npm install
npm run dev
```

Open [http://localhost:3003](http://localhost:3003).

## Config

`.env.local`:

```bash
STT_BASE_URL=http://spark-065b.local:8001
STT_MODEL=whisper-large-v3-turbo
STT_LANGUAGE=en

LLM_BASE_URL=http://spark-065b.local:8081
LLM_MODEL=gemma4-26b

TTS_BASE_URL=http://spark-065b.local:8880
TTS_VOICE=am_michael
TTS_MODEL=kokoro
TTS_SPEED=1.15                      # Kokoro rate (0.5-2.0)
TTS_MAX_SPEAK_WORDS=45              # heuristic / hard-cap safety net
NEXT_PUBLIC_TTS_REVEAL_LAG_MS=140   # raise if text still leads speech

LAYA_BASE_URL=http://spark-065b.local:8002 # empty = skip Laya, use the heuristic
LAYA_TIMEOUT_MS=2500
LAYA_SPEAK_THRESHOLD=0.5            # Laya detail score ≥ this → handoff
```

Other Kokoro voices work through `TTS_VOICE` (`am_fenrir`, `af_heart`, or blends like
`am_michael+af_bella`). This is an **original assistant voice**. Cloning a real person's voice, or
a film's, is off the table: open voicepacks are the practical and the lawful path.

## Behaviour

1. **Text or voice in** — same barge-in rules as phase 03.
2. **Laya runs on the user request immediately**, before the model finishes, and picks `speak` or
   `handoff`.
3. **Handoff** — a short cue is spoken straight away while the full answer streams into
   **Full answer**, so nobody waits for a thousand-word essay to finish before hearing anything.
4. **Speak-all** — Gemma is steered to keep it short, then Kokoro speaks it, with a length cap as
   a safety net.
5. If Laya is down or slow, the heuristic applies and nothing breaks.

## Barge-in

The hardest part of the loop, and the thing that separates a toy from something you would use.
Three things have to happen the instant the user starts talking over the agent:

1. VAD fires while the agent is still speaking.
2. The audio buffer is flushed, so playback stops mid-word.
3. The in-flight token stream is aborted, so the model stops generating a reply nobody will hear.

Miss any one of them and the agent talks over the user, or answers a question that was abandoned
two sentences ago. Try interrupting it mid-sentence; then look at `src/lib/playback.ts` and
`src/lib/stopCommand.ts` for how the three are wired together.

## Workshop talking points

1. TTS is the missing half of a voicebot. STT hears you, TTS talks back, and barge-in is what
   makes it a conversation rather than two monologues.
2. Not every token should be spoken. A System-1 model can decide delivery in ~0.2s without a
   second LLM call.
3. Word timestamps make the chat feel like live speech rather than dump-then-play.
4. Kokoro is 82M parameters. On the Spark it is a rounding error next to Gemma. The expensive part
   of a voice agent is not the voice.
5. Wear headphones. With thirty laptops in one room, barge-in will also pick up your neighbour.
