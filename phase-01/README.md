# Phase 01 — Browser Silero VAD

First building block of **Hey Gemma, No Internet**: detect when the user is speaking, entirely in the browser.

Powered by [Silero VAD](https://github.com/snakers4/silero-vad) through [`@ricky0123/vad-web`](https://github.com/ricky0123/vad) + ONNX Runtime Web (WASM). No backend. Microphone audio never leaves the client.

## Pipeline

```
Microphone → AudioWorklet → Silero ONNX (WASM) → Speech segments (WAV)
```

Later phases can feed those segments into STT, an LLM, and TTS.

## Setup

```bash
cd phase-01
npm install          # once, at the repo root (cd ..). Also copies ONNX / WASM / worklet into public/vad
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), allow the mic, then **Start listening**.

## Workshop talking points

1. **Why VAD first?** Gemma should not stream silence — VAD cuts the audio into utterances.
2. **Why Silero?** Open-source, accurate, small enough to run in-browser via ONNX.
3. **Why browser?** Zero infra for demos; privacy-friendly; great for workshops.
4. **What you get:** `onSpeechEnd` yields a `Float32Array` @ 16 kHz — ready for Whisper / other STT next.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run assets` | Re-copy Silero / ORT files into `public/vad` |
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |

## Notes

- Assets under `public/vad/` are generated (gitignored). Always run `npm install` (at the repo root) or `npm run assets` after a fresh clone.
- HTTPS or `localhost` is required for `getUserMedia`.
- Model default: Silero **v5** (`model: "v5"` in `VadDemo.tsx`). You can switch to `"v6"` or `"legacy"`.
