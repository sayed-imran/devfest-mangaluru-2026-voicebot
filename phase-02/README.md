# Phase 02 — VAD + Speech-to-Text

Builds on Phase 01: Silero VAD still runs in the browser, and each detected utterance now gets
turned into text by **Whisper large-v3-turbo running on the DGX Spark** in the room.

```
your laptop                                         DGX Spark
───────────                                         ─────────
Microphone → Silero VAD → WAV clip → /api/transcribe ── LAN ──▶ Whisper via vLLM (:8001)
```

Your laptop downloads no model and runs no inference. Only speech segments leave the browser, and
they go no further than the Spark on the local network.

## Prerequisites

Nothing beyond Node 20+. The presenter has the Spark running ([../spark/README.md](../spark/README.md)).
Check you can reach it:

```bash
curl http://spark-065b.local:8001/v1/models
```

If `spark-065b.local` does not resolve, use the IP on the slide and put it in `.env.local`.

## App

```bash
cd phase-02
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001). It uses port **3001** so it can run beside
phase-01. Keep it on `localhost`: browsers only allow the microphone on secure origins.

## Config

`.env.local`:

```bash
STT_BASE_URL=http://spark-065b.local:8001
STT_MODEL=whisper-large-v3-turbo
STT_LANGUAGE=en                 # ISO-639-1
```

`POST /api/transcribe` forwards the clip to the OpenAI-compatible `/v1/audio/transcriptions`
endpoint and returns `{ text, model }`. The browser only ever talks to its own Next.js server,
never to the Spark directly.

## Try this

- Say a proper noun ("Mangaluru", "Kudla", your own name) and see what comes back.
- Change `STT_LANGUAGE` to `hi` or `kn` and speak that language.
- Mumble, or talk over music. A dedicated ASR model holds up here.
- Look at the Network tab: one request per utterance and none during silence.

## Workshop talking points

1. VAD decides *when* to listen; STT decides *what was said*.
2. Only speech segments are transcribed. Silence never leaves the browser, which protects privacy
   and saves compute on the shared box.
3. "Local" is a network boundary, not necessarily your own machine. The audio stays on the LAN.
4. The transcript is the handoff into phase 03.
