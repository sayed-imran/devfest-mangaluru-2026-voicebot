# Finale — One box, the whole room

The presenter runs this closing segment, and attendees have nothing new to install. Everyone keeps
using their [phase 05](phase-05/) app. On the projector you measure what the room has relied on
since phase 02: a single NVIDIA DGX Spark on the local network serving Gemma, Whisper, Kokoro and
Laya to everyone at once, with no internet.

```
30 laptops                                   DGX Spark (GB10, 128 GB unified)
──────────                                   ────────────────────────────────
browser: Silero VAD                          :8001  Whisper large-v3-turbo   vLLM
phase-05 app :3004     ──── LAN ──────────▶  :8081  Gemma 4 26B A4B          vLLM, batched
tools service (no model)                     :8880  Kokoro
                                             :8002  Laya
```

## What the Spark actually is

| | |
| --- | --- |
| Chip | GB10 Grace Blackwell superchip |
| Memory | 128 GB unified, shared by CPU and GPU |
| Bandwidth | ~273 GB/s |
| Power | 240 W external power supply, standard wall socket |

That trade is the lesson. Unified memory means no PCIe transfers and room for models a consumer
GPU cannot hold. But ~273 GB/s is far below an RTX 5090's ~1,792 GB/s, so tokens per second for a
single user are lower, not higher. You are buying **capacity and concurrency**, not single-stream
speed.

Two choices make one box work for a room:

1. **Gemma 4 26B A4B.** It is a Mixture-of-Experts model: 25.2B parameters in total, but only
   **3.8B active per token**. It decodes about as fast as a 4B dense model, while its memory use is
   closer to a dense 26B. That is the right trade for a large pool of memory with limited bandwidth.
2. **vLLM continuous batching.** Thirty requests in flight share one pass over the weights. When
   memory bandwidth is the bottleneck, batching is almost free throughput: each extra user costs
   far less than a second copy of the model would.

## 1. Measure the room

From the presenter's laptop. It needs only the Python standard library.

```bash
python bench/bench.py --label "1 user"   --concurrency 1
python bench/bench.py --label "8 users"  --concurrency 8
python bench/bench.py --label "30 users" --concurrency 30

python bench/bench.py --compare 'bench/results/*.json'
```

```
| Run      | Model      | Users |  TTFT | p95 TTFT |  Decode |  Prefill |
| 1 user   | gemma4-26b |     1 |   ... |      ... |     ... |      ... |
| 8 users  | gemma4-26b |     8 |   ... |      ... |     ... |      ... |
| 30 users | gemma4-26b |    30 |   ... |      ... |     ... |      ... |
```

Run it once before the workshop so you have a baseline slide, then again live.

## 2. Everyone at once

Ask the whole room to talk to their phase 05 bot at the same moment, while
`nvidia-smi` and `docker stats` run on the Spark on the projector.

What to look for:

- **Decode per user** drops as users increase, but much more slowly than 1/N. That gap is
  batching.
- **p95 TTFT** is the number a voice agent lives or dies on. A typical conversation starts to
  feel slow at around 500 ms. Find the user count where you cross it.
- Anything above ~3 tok/s per user is faster than speech. Past that point, decode speed only adds
  headroom.

See [bench/README.md](bench/README.md) for what each metric means, and the caveat about
estimated token counts.

## 3. Turn the knobs (optional, if time allows)

On the Spark, in `spark/.env` (see [spark/README.md](spark/README.md#sizing-for-a-room)):

| Try | Expect |
| --- | --- |
| `LLM_MAX_SEQS=8` | Users beyond 8 queue. p95 TTFT climbs steeply while decode per user improves |
| `LLM_MAX_LEN=4096` | More KV cache slots, so more concurrent turns fit before anyone queues |
| Swap to `google/gemma-4-31B-it` | Dense: every token reads all 31B weights. Notice the per-user decode drop |

Each change needs `docker compose up -d llm` and a few minutes to reload, during which every
attendee's bot is offline. Do it last, or skip it and show the numbers from a rehearsal run. The
31B is not cached on the Spark, so swapping to it needs internet and a large download. Do that
before the day if you want it.

## Where should a workload run?

| Signal | Put it |
| --- | --- |
| Audio or documents that must not leave the device | On-device |
| A team sharing capacity, models too big for a laptop, fixed cost | On-prem appliance |
| Spiky traffic, or frontier-size models | Cloud |

This room was the second row: a voice agent for 30 people, on one desktop box plugged into a wall
socket, with no internet. That is the sentence to leave with, and you now have the numbers behind
it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Everything slow for everyone | Check `docker stats` on the Spark. If `llm` is pinned, the batch is full. That is the lesson, so show it |
| One laptop can't connect, others can | That laptop can't resolve `spark-065b.local`. Put the Spark's IP in its `.env.local` |
| `bench.py` says it can't reach the Spark | `./spark/smoke.sh spark-065b.local`, or pass `--base-url http://<ip>:8081` |

## Talking points

1. Moving inference onto the LAN changed no client code, only URLs in `.env.local`. That is the
   payoff of an OpenAI-compatible API.
2. Unified memory buys capacity, not bandwidth. Know which of the two your workload lacks.
3. MoE plus batching is how one small box serves a room.
4. "Where should this run?" has a numeric answer, and you measured it in this room.
