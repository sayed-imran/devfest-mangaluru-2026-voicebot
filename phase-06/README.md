# Phase 06 — The Spark (same code, different box)

Nothing in this app changed from phase 05. One environment variable did.

```diff
- LLM_BASE_URL=http://127.0.0.1:8081     # Gemma 4 E4B, your laptop
- LLM_MODEL=gemma4-e4b
+ LLM_BASE_URL=http://spark-065b:8081    # Gemma 4 26B A4B, the box on the room's network
+ LLM_MODEL=gemma4-26b
```

That is the point of the phase. LiteRT-LM speaks the same OpenAI-compatible API whether it is
running on your laptop or on an NVIDIA DGX Spark, so moving the model from a process on your
machine to a shared appliance on the LAN is a config change, not a rewrite. The network cable is
still unplugged from the internet; the model simply lives one hop away.

```
Your laptop                              DGX Spark (GB10, 128GB unified)
───────────                              ───────────────────────────────
Silero VAD (browser)
Kokoro TTS        ──── LAN ────────────▶ LiteRT-LM :8081  Gemma 4 26B A4B
tools service                            Laya :8002
web app :3005                            Kokoro :8880 (optional, GPU)
```

## What the Spark actually is

| | |
| --- | --- |
| Chip | GB10 Grace Blackwell superchip |
| Memory | 128 GB unified, shared by CPU and GPU |
| Bandwidth | ~273 GB/s |
| Power | ~95 W from a standard wall socket |

The trade is the whole lesson. Unified memory means no PCIe transfers and room for models a
consumer GPU cannot hold, but ~273 GB/s against an RTX 5090's ~1,792 GB/s means token generation
per user is slower, not faster. You are buying **capacity and concurrency**, not single-stream
speed.

Gemma 4 26B A4B is chosen to fit that shape: a Mixture-of-Experts model with 25.2B total
parameters but only **3.8B active per token**. It decodes roughly as fast as a 4B dense model
while occupying memory closer to a dense 26B — exactly the right trade for a big, bandwidth-limited
memory pool. Turn on `speculative_decoding` in the LiteRT-LM config; on a bandwidth-bound machine
it earns its keep.

## 1. On the Spark

```bash
ssh spark-065b

# serve the 26B to the room, not just to localhost
LITERT_HOST=0.0.0.0 ./litert/serve.sh gemma4-26b

# supporting services
cd phase-06
docker compose up -d --build        # Kokoro (GPU) + Laya (CPU)
```

Check from your own laptop:

```bash
curl http://spark-065b:8081/v1/models
curl http://spark-065b:8880/v1/models
```

If the hostname does not resolve, use the Spark's IP and put it in `next.config.ts` under
`allowedDevOrigins`.

## 2. On your laptop

```bash
cd phase-06
npm install
npm run dev                          # http://localhost:3005
```

The tools service still runs **on your laptop** — it opens windows on your screen, so it has to
be where your screen is. Only the model moved.

```bash
cd phase-06/tools-service
cp .env.example .env                 # already points LLM_BASE_URL at the Spark
./start.sh
```

## A wrinkle worth saying out loud

The 26B and 31B models do **not** accept audio input; only E2B, E4B and 12B do. So the moment you
move reasoning to the 26B, `STT_MODE=gemma` can no longer point at the same model. Two options:

1. Keep a small model on the Spark for audio alongside the 26B, which is what `.env.local` does by
   default (`STT_GEMMA_MODEL=gemma4-e4b`).
2. Set `STT_MODE=whisper` and run `docker compose --profile whisper up -d` on the Spark.

This is a good live moment: consolidating stages into one multimodal model is elegant right up
until you want a model size that does not have that modality.

## 3. Benchmark it

The argument for local inference at work is a number, not a preference. Run the same harness on
each machine and put the table on a slide:

```bash
python bench/bench.py --label "Raspberry Pi 5" --model gemma4-e2b --base-url http://127.0.0.1:8081
python bench/bench.py --label "Laptop (CPU)"   --model gemma4-e4b --base-url http://127.0.0.1:8081
python bench/bench.py --label "Laptop (GPU)"   --model gemma4-e4b --base-url http://127.0.0.1:8081
python bench/bench.py --label "DGX Spark"      --model gemma4-26b --base-url http://spark-065b:8081

python bench/bench.py --compare 'bench/results/*.json'
```

See [../bench/README.md](../bench/README.md) for what prefill, decode and TTFT each tell you, and
for the caveat about estimated token counts.

The result is usually more interesting than "the big box wins". A laptop running E4B is often
already decoding faster than anyone speaks, which means the Spark's extra speed buys a single user
nothing — what it actually buys is a larger model and the whole room at once.

## Where should a workload run?

| Signal | Put it |
| --- | --- |
| Audio or documents that must not leave the device | On-device |
| A team sharing capacity, models too big for a laptop, fixed cost | On-prem appliance |
| Spiky traffic, or genuinely frontier-size models | Cloud |

Most voice work lands in the first two rows. That is the sentence to leave the room with, and by
this point you have your own numbers behind it.

## Config

`.env.local` differs from phase 05 only in where things point:

```bash
LLM_BASE_URL=http://spark-065b:8081
LLM_MODEL=gemma4-26b

STT_GEMMA_BASE_URL=http://spark-065b:8081
STT_GEMMA_MODEL=gemma4-e4b      # 26B has no audio input

TTS_BASE_URL=http://spark-065b:8880
LAYA_BASE_URL=http://spark-065b:8002

TOOLS_BASE_URL=http://127.0.0.1:8765   # stays local: it drives your screen
```

Flip those four Spark URLs back to `127.0.0.1` and you are running phase 05 again. Doing that
mid-demo, with the conversation still going, is the cleanest way to show that the client never
knew the difference.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Works on localhost, not from the laptop | LiteRT-LM defaults to binding `0.0.0.0`, but the serve script defaults to `127.0.0.1`. Start it with `LITERT_HOST=0.0.0.0`. |
| Next.js blocks the LAN hostname | Add it to `allowedDevOrigins` in `next.config.ts`. |
| First request after startup is very slow | Weights optimise for the device once, then cache. Warm it before the demo. |
| Decode slower than expected on the Spark | Unified memory is bandwidth-bound. Enable `speculative_decoding`, and check you are at 8-bit rather than bf16. |
| Thirty people, one Spark, everything crawls | That *is* the lesson. Show it, then show the laptop still working offline. |

## Workshop talking points

1. One environment variable moved the model off the laptop. That portability is the practical
   payoff of standardising on an OpenAI-compatible API.
2. Unified memory buys capacity, not bandwidth. Know which one your workload is short of.
3. MoE is how a 26B model behaves like a 4B one at decode time.
4. "Where should this run?" has a numeric answer, and you measured it in this room.
