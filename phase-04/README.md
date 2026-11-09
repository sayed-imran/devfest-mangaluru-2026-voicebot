# Phase 04 — Voice replies (VAD + STT + Gemma 4 + TTS)

Gemma **talks back**, and learns to be interrupted.
[Laya](https://github.com/NandhaKishorM/laya) decides whether a reply should be fully spoken or
only announced ("detailed answer is in the chat"). Short spoken answers use Kokoro with
word-synced chat text; handoffs put the full write-up on screen.

```
Mic → Silero VAD → STT ─┐
Text box ───────────────┤
                        ├→ Gemma 4 via LiteRT-LM (:8081) → reply
                        │
     Laya (:8002) on user intent → speak vs handoff
                        │
     speak-all ──→ short Gemma reply → Kokoro (:8880) speaks it
     handoff ────→ speak a short cue *while* the full answer streams to chat
```

## Prerequisites

The model still comes from LiteRT-LM on your own machine. Docker only brings up the pieces
around it, and the defaults are CPU so a laptop can run all of this:

```bash
./litert/serve.sh                      # terminal 1: Gemma 4 E4B on :8081

cd phase-04
docker compose up -d --build           # terminal 2: Kokoro (CPU) + Laya (CPU)
```

| Service | Where | Port | Notes |
| --- | --- | --- | --- |
| Gemma 4 | LiteRT-LM, your machine | 8081 | `./litert/serve.sh` |
| STT | same LiteRT-LM server | 8081 | `STT_MODE=gemma` |
| Kokoro TTS | docker | 8880 | 82M params, CPU is fine |
| Laya | docker | 8002 | optional, CPU on purpose |

Variants:

```bash
docker compose --profile gpu up -d        # Kokoro on an NVIDIA GPU instead
docker compose --profile whisper up -d    # add Whisper, for STT_MODE=whisper
```

Health checks:

```bash
curl http://127.0.0.1:8081/v1/models
curl http://localhost:8880/v1/models      # TTS web UI: http://localhost:8880/web/
curl http://localhost:8002/health
```

First Laya boot downloads the English checkpoint into the `laya-hf-cache` volume (a few minutes).
Laya is optional: leave `LAYA_BASE_URL` empty and a word-count heuristic takes over.

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
STT_MODE=gemma
STT_GEMMA_BASE_URL=http://127.0.0.1:8081
STT_GEMMA_MODEL=gemma4-e4b
STT_LANGUAGE=en

LLM_BASE_URL=http://127.0.0.1:8081
LLM_MODEL=gemma4-e4b

TTS_BASE_URL=http://127.0.0.1:8880
TTS_VOICE=am_michael
TTS_MODEL=kokoro
TTS_SPEED=1.15                      # Kokoro rate (0.5-2.0)
TTS_MAX_SPEAK_WORDS=45              # heuristic / hard-cap safety net
NEXT_PUBLIC_TTS_REVEAL_LAG_MS=140   # raise if text still leads speech

LAYA_BASE_URL=http://127.0.0.1:8002 # empty = skip Laya, use the heuristic
LAYA_TIMEOUT_MS=2500
LAYA_SPEAK_THRESHOLD=0.7
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
4. Kokoro is 82M parameters and runs on a CPU. The expensive part of a voice agent is not the voice.
