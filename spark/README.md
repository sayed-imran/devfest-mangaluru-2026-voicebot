# The DGX Spark: every model in the room

All models for the workshop run on one NVIDIA DGX Spark on the room's local network. Attendee
laptops download no weights and run no inference. They run the Next.js app, which calls the
Spark over LAN. Nothing goes out to the internet.

```
 attendee laptop                          DGX Spark (spark-065b.local)
 ───────────────                          ──────────────────────────────────────────────
 browser: mic + Silero VAD                 :8001  Whisper large-v3-turbo   vLLM
 Next.js app (phase 02-05) ──── LAN ────▶  :8081  Gemma 4 26B A4B          vLLM, tool calling
 tools service (phase 05+, no model)       :8880  Kokoro TTS
                                           :8002  Laya speak-vs-handoff
```

The only thing in the phases that runs in the browser is Silero VAD (phase 01), and its ~2 MB ONNX
file ships inside `npm install`.

## Before the day (on wifi, once)

```bash
ssh spark-065b.local
git clone <this repo> && cd devfest-mangaluru-voicebot/spark
cp .env.example .env          # paste HF_TOKEN; accept the Gemma 4 licence on Hugging Face first
docker compose pull
docker compose build laya
docker compose up -d          # first start downloads ~55 GB of Gemma weights plus Whisper and Laya
docker compose logs -f llm    # wait for "Application startup complete"
./smoke.sh
```

Once `./smoke.sh` passes, set `HF_HUB_OFFLINE=1` in `.env` and run `docker compose up -d` again.
From then on the Spark never needs the internet. Unplug the uplink and run `./smoke.sh` again
to prove it.

## On the day

1. Put the Spark and the room on the same switch or access point. Give the Spark a fixed
   address.
2. Check that `spark-065b.local` resolves from a laptop (`ping spark-065b.local`). The bare name
   `spark-065b` does **not** resolve. Only the mDNS `.local` name does, and it works out of the
   box on macOS and Windows 10+, but needs `avahi`/`nss-mdns` on Linux. Put the IP on a slide
   anyway: attendees whose laptop can't resolve the name replace `spark-065b.local` in their
   phase's `.env.local` with it.
3. Prefer Ethernet for the Spark. With 30 laptops on the same Wi-Fi, a wired Spark keeps
   audio uploads and token streams off the most crowded link.
4. From your own laptop: `./spark/smoke.sh spark-065b.local`.
5. Keep `docker stats` and `nvidia-smi` open on a second screen. Watching the room load it is
   part of the [finale](../finale.md).

## Sizing for a room

| Knob (`.env`) | Default | What it does |
| --- | --- | --- |
| `LLM_GPU_MEM` | `0.55` | Share of the 128 GB pool vLLM may use for Gemma weights plus KV cache |
| `LLM_MAX_SEQS` | `48` | Concurrent requests batched together. Set it a little above the head count |
| `LLM_MAX_LEN` | `16384` | Context per request. Voice turns are short, so lowering it leaves more room for concurrent requests |
| `STT_GPU_MEM` | `0.10` | Whisper's share |

Gemma 4 26B A4B is a Mixture-of-Experts model with only 3.8B parameters active per token. It
decodes almost as fast as a 4B model, and vLLM's continuous batching lets 30 people talking at
once share one copy of the weights. If the Spark runs short of memory, lower `LLM_MAX_LEN`
before `LLM_MAX_SEQS`.

Sizes and quantization trade-offs: [models.md](models.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `llm` restarts with a 401/403 | `HF_TOKEN` missing, or the Gemma licence has not been accepted on Hugging Face |
| `unrecognized arguments: --tool-call-parser gemma4` | The vLLM image predates Gemma 4. Use the image tag in `.env.example` or newer |
| CUDA out of memory at start | `LLM_GPU_MEM + STT_GPU_MEM` is too high for what else is running. Drop `LLM_GPU_MEM` to 0.5 |
| Kokoro container exits with `exec format error` | The image has no arm64 build. Set `KOKORO_IMAGE` to the `-cpu` tag |
| Tool calls come back as text | The tools service parses that too (`gemma_tools/llm.py`), but check that `--tool-call-parser=gemma4` is set |
| Laptops can't reach a port | Check the Spark firewall: `sudo ufw allow 8001,8002,8081,8880/tcp` |
