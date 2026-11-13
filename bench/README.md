# bench — what does one box do for a whole room?

Every attendee's voicebot shares one Gemma 4 on the DGX Spark. This harness measures what that
sharing costs: time-to-first-token, decode and prefill, at the concurrency the room actually
produces.

No dependencies beyond the Python standard library. It defaults to `http://spark-065b.local:8081` and
`gemma4-26b`, or `LLM_BASE_URL` / `LLM_MODEL` from the environment.

## Measure

```bash
python bench/bench.py --label "1 user"   --concurrency 1
python bench/bench.py --label "8 users"  --concurrency 8
python bench/bench.py --label "30 users" --concurrency 30 --notes "FP8, max-num-seqs 48"
```

With `--concurrency N`, each run fires N identical requests together and records every one of
them. Each run writes `bench/results/<label>-<model>-c<N>.json`.

## Compare

```bash
python bench/bench.py --compare 'bench/results/*.json'
```

```
| Run                    | Model        | Users |      TTFT |  p95 TTFT |       Decode |       Prefill |
| ---------------------- | ------------ | ----- | --------- | --------- | ------------ | ------------- |
| 1 user                 | gemma4-26b   |     1 |    ....ms |    ....ms |   ....tok/s  |    ....tok/s  |
| 8 users                | gemma4-26b   |     8 |    ....ms |    ....ms |   ....tok/s  |    ....tok/s  |
| 30 users               | gemma4-26b   |    30 |    ....ms |    ....ms |   ....tok/s  |    ....tok/s  |
```

Paste that table straight onto the benchmarks slide.

## What the numbers mean

| Metric | Definition | Why it is on the slide |
| --- | --- | --- |
| **TTFT** / **p95 TTFT** | Request sent to first content token: median, and the slowest 5% | What makes a voice agent feel alive. Past roughly 500ms a conversation starts to feel like a form submission. Under load, p95 is what the unluckiest person in the room feels. |
| **Decode** | Output tokens per second after the first | How fast it talks. Anything above speaking rate (~3 tok/s) is enough for voice; more just buys headroom. |
| **Prefill** | Prompt tokens per second | How fast it reads. Irrelevant for one-liners, decisive when you hand it a document. |

Three prompt shapes run by default — a one-liner, a normal conversational turn, and a long
pasted document — because prompt shape moves prefill a lot and decode barely at all. The script
reports the median across runs.

## The honest caveat

Token counts come from the server's `usage` block. Streaming responses frequently omit it, so the
script requests `stream_options.include_usage` and, if the server ignores that, falls back to
estimating tokens at roughly four characters each. When that happens every affected row is marked
with `*` and the JSON carries `"tokens_estimated": true`.

Estimated numbers are fine for a relative comparison between machines. Do not present them as
measured throughput.

## Reading the result

The interesting outcome is *where the curve bends*. Decode per user falls as concurrency rises,
but far more slowly than 1/N, because vLLM batches every in-flight request into one pass over the
weights. Per-user speed stays above speaking rate well past the point where you'd expect it to
drop. What 128 GB of unified memory buys is a bigger model and the whole room at once, not speed
for one person. That distinction is the argument for on-prem inference at work, and it only lands
with your own numbers behind it.
