# LiteRT-LM — the local inference engine

Every phase from 03 onward talks to an **OpenAI-compatible endpoint**. On your laptop that endpoint is
[LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM), Google AI Edge's on-device inference engine.
In phase 06 the same endpoint moves to the DGX Spark. The application code does not change.

```
phase-03..05   app ──▶ http://127.0.0.1:8081/v1   LiteRT-LM on your laptop   (Gemma 4 E4B)
phase-06       app ──▶ http://spark-065b:8081/v1  LiteRT-LM on the Spark     (Gemma 4 26B A4B)
```

## 1. Install

```bash
uv tool install litert-lm          # or: pip install litert-lm
litert-lm --version
```

Linux, macOS, Windows and Raspberry Pi are supported. Python 3.10+.

## 2. Import a model into the local registry

`litert-lm serve` serves models from a local registry, so each model is imported once and then
referred to by a short alias. The alias is what clients send in the OpenAI `model` field.

```bash
# Laptop (the workshop default)
litert-lm import \
  --from-huggingface-repo=litert-community/gemma-4-E4B-it-litert-lm \
  gemma-4-E4B-it.litertlm \
  gemma4-e4b
```

```bash
# Raspberry Pi / 8GB machines
litert-lm import \
  --from-huggingface-repo=litert-community/gemma-4-E2B-it-litert-lm \
  gemma-4-E2B-it.litertlm \
  gemma4-e2b
```

```bash
# DGX Spark (phase 06)
litert-lm import \
  --from-huggingface-repo=litert-community/gemma-4-26B-A4B-it-litert-lm \
  gemma-4-26B-A4B-it.litertlm \
  gemma4-26b
```

On Windows use backtick line continuations instead of `\`.

Check what is registered:

```bash
litert-lm list
```

## 3. Serve

```bash
litert-lm serve --host 127.0.0.1 --port 8081
```

Flags: `--host` (default `0.0.0.0`), `--port` (default `9379`), `--verbose`.
The repo standardises on **8081** so it never collides with the Next.js dev ports (3000-3005),
Kokoro (8880) or the tools service (8765).

Helper scripts that do the import-if-missing then serve:

| OS | Command |
| --- | --- |
| macOS / Linux | `./litert/serve.sh` |
| Windows | `litert\serve.cmd` |

Both accept an alias: `./litert/serve.sh gemma4-e2b`.

Smoke test:

```bash
curl http://127.0.0.1:8081/v1/models

curl http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma4-e4b","messages":[{"role":"user","content":"Say hello in five words."}]}'
```

The app's health check hits `/v1/models`, so if that curl works the header in the web app turns green.

## 4. Configuration

LiteRT-LM reads `~/.litert-lm/config.json` (Windows: `%USERPROFILE%\.litert-lm\config.json`).
Most tuning lives here rather than on the command line. A `default` section applies to every
model; a `models` map overrides per alias.

A config that suits this workshop:

```json
{
  "default": {
    "max_num_tokens": 4096,
    "temperature": 0.7,
    "top_p": 0.95,
    "cache": "memory"
  },
  "models": {
    "gemma4-e4b": {
      "backend": "gpu",
      "cpu_thread_count": 8
    },
    "gemma4-e2b": {
      "backend": "cpu",
      "cpu_thread_count": 4
    },
    "gemma4-26b": {
      "backend": "gpu",
      "speculative_decoding": true,
      "max_num_tokens": 8192
    }
  }
}
```

A copy lives at [`config.example.json`](config.example.json).

Notes:

- `backend` is `"cpu"`, `"gpu"` or `"npu"`, and `audio_backend` / `vision_backend` set the same for
  the audio and image paths. Not every model supports every backend; if initialisation fails, drop
  back to the model's embedded default by removing the key.
- `speculative_decoding` matters most on the Spark. Gemma 4 ships a draft model for multi-token
  prediction, and unified memory is bandwidth-bound, so speculative decoding buys real wall-clock.
- Precedence, highest first: runtime arguments, per-model config, `default` config, model metadata,
  engine built-ins.
- Strict JSON only. Google's documentation example shows `//` comments and trailing commas; leave
  those out of a real file.

## 5. Picking a size

See [`models.md`](models.md) for the full table. The short version:

| You have | Run | Alias |
| --- | --- | --- |
| Raspberry Pi, phone, 8GB laptop | Gemma 4 E2B | `gemma4-e2b` |
| Ordinary laptop, 16GB | Gemma 4 E4B | `gemma4-e4b` |
| 16GB GPU or unified memory | Gemma 4 12B Unified | `gemma4-12b` |
| DGX Spark, 128GB unified | Gemma 4 26B A4B | `gemma4-26b` |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `model not found` from the server | The alias is not in the registry. Run `litert-lm list`, then `litert-lm import …`. |
| First request takes 30s+ | Weights are being optimised for your device on first load. It is cached afterwards. |
| App header shows the LLM offline | The server defaults to port 9379, this repo expects 8081. Pass `--port 8081`. |
| Backend init fails on GPU | Remove the `backend` key for that model so it uses its embedded default. |
| Out of memory on the laptop | Drop to `gemma4-e2b`, or lower `max_num_tokens`. |
