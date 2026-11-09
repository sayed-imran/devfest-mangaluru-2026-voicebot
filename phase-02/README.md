# Phase 02 — VAD + Speech-to-Text

Builds on Phase 01: Silero VAD still runs in the browser, and each detected utterance now gets
turned into text.

There are **two routes to text**, and this phase exists partly so you can hear the difference.

```
                                        ┌─ STT_MODE=gemma    Gemma 4 E4B via LiteRT-LM (:8081)
Microphone → Silero VAD → WAV clip ─────┤
                                        └─ STT_MODE=whisper  Whisper via vLLM (:8001)
```

| | `gemma` (default) | `whisper` |
| --- | --- | --- |
| What runs | The LiteRT-LM server you already need for phase 03 | A second service |
| Hardware | Laptop, CPU is fine | NVIDIA GPU |
| Hops in the chain | One model does audio and reasoning | Two models |
| Accuracy | Good; Gemma 4 E2B/E4B take audio natively | State of the art |
| Why you'd pick it | Nothing extra to run, nothing extra to ship | Dedicated ASR, better on hard accents and noise |

Gemma 4 E2B, E4B and 12B accept audio input directly. That is new, and it quietly deletes a box
from everyone's architecture diagram. The 26B and 31B do not, which matters in phase 06.

## Setup — route A: Gemma (default)

Nothing to install beyond LiteRT-LM. From the repo root:

```bash
./litert/serve.sh          # Gemma 4 E4B on http://127.0.0.1:8081
```

See [../litert/README.md](../litert/README.md) if that is your first run.

## Setup — route B: Whisper

Needs an NVIDIA GPU and Hugging Face access:

```bash
cd phase-02
# export HF_TOKEN=...   # if models are gated
docker compose -f docker-compose.whisper.yaml up -d
curl http://localhost:8001/v1/models
```

Then set `STT_MODE=whisper` in `.env.local`.

## App

```bash
cd phase-02
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) (port **3001** so it can run beside phase-01).

## Config

`.env.local`:

```bash
STT_MODE=gemma                  # gemma | whisper
STT_LANGUAGE=en                 # ISO-639-1

# STT_MODE=gemma
STT_GEMMA_BASE_URL=http://127.0.0.1:8081
STT_GEMMA_MODEL=gemma4-e4b

# STT_MODE=whisper
STT_BASE_URL=http://spark-065b:8001
STT_MODEL=openai/whisper-large-v3-turbo
```

`POST /api/transcribe` handles both and returns the same `{ text, model, mode }` either way, so
nothing downstream has to know which route ran. Switching is one line in `.env.local` plus a
dev-server restart — worth doing live, mid-sentence, to show the seam is real.

## Try this

- Say the same sentence on each route and compare. Whisper usually wins on proper nouns and
  accents; Gemma is usually close enough and saves you a service.
- Mumble, or talk over music. This is where a dedicated ASR model earns its place.
- Watch the first Gemma request after a cold start: weights are optimised for your device once,
  then cached.

## Workshop talking points

1. VAD decides *when* to listen; STT decides *what was said*.
2. Only speech segments are transcribed — silence never leaves the browser, which is both a
   privacy property and a compute saving.
3. Multimodal models are collapsing pipeline stages. "Which model does STT?" is becoming
   "do I need an STT model at all?"
4. The transcript is the handoff into phase 03.
