# bench — where does your workload actually belong?

The claim the talk ends on is that most voice workloads belong on-device or on-prem, not in a
datacentre. That is only worth saying with numbers from the room, so this harness produces them.

No dependencies beyond the Python standard library.

## Measure

Run it once per machine, against whatever that machine is serving:

```bash
# Raspberry Pi 5, Gemma 4 E2B
python bench/bench.py --label "Raspberry Pi 5" --model gemma4-e2b \
  --base-url http://127.0.0.1:8081 --notes "QAT 4-bit, CPU backend"

# Workshop laptop, Gemma 4 E4B
python bench/bench.py --label "Laptop (CPU)" --model gemma4-e4b \
  --base-url http://127.0.0.1:8081 --notes "QAT 4-bit, 8 threads"

python bench/bench.py --label "Laptop (GPU)" --model gemma4-e4b \
  --base-url http://127.0.0.1:8081 --notes "GPU backend"

# DGX Spark, Gemma 4 26B A4B
python bench/bench.py --label "DGX Spark" --model gemma4-26b \
  --base-url http://spark-065b:8081 --notes "8-bit, speculative decoding on"
```

Each run writes `bench/results/<label>-<model>.json`.

## Compare

```bash
python bench/bench.py --compare 'bench/results/*.json'
```

```
| Machine                | Model        |      TTFT |       Decode |       Prefill |
| ---------------------- | ------------ | --------- | ------------ | ------------- |
| Raspberry Pi 5         | gemma4-e2b   |    ....ms |   ....tok/s  |    ....tok/s  |
| Laptop (CPU)           | gemma4-e4b   |    ....ms |   ....tok/s  |    ....tok/s  |
| Laptop (GPU)           | gemma4-e4b   |    ....ms |   ....tok/s  |    ....tok/s  |
| DGX Spark              | gemma4-26b   |    ....ms |   ....tok/s  |    ....tok/s  |
```

Paste that table straight onto the benchmarks slide.

## What the three numbers mean

| Metric | Definition | Why it is on the slide |
| --- | --- | --- |
| **TTFT** | Request sent to first content token | What makes a voice agent feel alive. Past roughly 500ms a conversation starts to feel like a form submission. |
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

The interesting outcome is usually not "the Spark wins". It is *where the curve flattens*. A
laptop running E4B is often already past speaking rate, which means the extra decode speed on the
Spark buys nothing for a single user, and what you are really buying with 128GB of unified memory
is a bigger model and many concurrent users. That distinction is the argument for local inference
at work, and it only lands with your own numbers behind it.
