# Gemma 4 sizes, memory and quantization

Gemma 4 is released under Apache 2.0 in five sizes. Choosing one is mostly a memory question, and
quantization is what makes the choice interesting.

## The family

| Model | Parameters | Context | Audio in | Best for |
| --- | --- | --- | --- | --- |
| E2B | 2.3B effective (5.1B with embeddings) | 128K | yes | Phones, Raspberry Pi, 8GB laptops |
| E4B | 4.5B effective (8B with embeddings) | 128K | yes | Small enough for a laptop; not used in this workshop |
| 12B Unified | 11.95B, encoder-free | 256K | yes | 16GB GPU or unified memory |
| 26B A4B | 25.2B total, **3.8B active** (MoE) | 256K | no | DGX Spark, workstations |
| 31B Dense | 30.7B | 256K | no | 32GB+ GPU |

The 26B is a Mixture-of-Experts model: only 3.8B parameters activate per token, so it generates
nearly as fast as a 4B dense model while needing memory closer to a dense 26B. That trade, fast
decode in exchange for a large resident footprint, is exactly what 128GB of unified memory is for.

All five ship a draft model for multi-token prediction, so speculative decoding is available
without extra setup.

## Memory by precision

Weights only, before KV cache. Source: Google's Gemma 4 model overview.

| Model | bf16 | 8-bit | 4-bit |
| --- | --- | --- | --- |
| E2B | 11.4 GB | 5.7 GB | 2.9 GB |
| E4B | 17.9 GB | 8.9 GB | 4.5 GB |
| 12B | 26.7 GB | 13.4 GB | 6.7 GB |
| 26B A4B | 57.7 GB | 28.8 GB | 14.4 GB |
| 31B | 69.9 GB | 34.9 GB | 17.5 GB |

E2B and E4B go lower still with Google's quantization-aware-training builds, to roughly 1.1 GB and
2.5 GB respectively. The QAT builds are the ones to use on constrained hardware: they are trained
with quantization in the loop, so the quality cost is much smaller than post-training quantization
at the same bit width.

## What quantization actually costs you

The honest framing for the workshop:

- **Memory**: roughly linear. 4-bit is about a quarter of bf16. This is the whole reason a 26B model
  fits on a 128GB box alongside everything else.
- **Quality**: small and task-dependent. Summarisation and chat degrade gracefully; exact arithmetic,
  long-chain reasoning and strict JSON tool arguments degrade first. If function calling starts
  emitting malformed arguments after you quantize, that is the signal.
- **Speed**: not automatic. Lower precision moves fewer bytes, which helps on a bandwidth-bound
  machine like the Spark. On a CPU without the right kernels it can be *slower* than 8-bit.

Measure it rather than assuming it. `bench/` runs the same prompts across precisions and machines.

## Why the workshop uses the 26B on the Spark

| Option | Fits a shared Spark? | Audio in | Notes |
| --- | --- | --- | --- |
| 26B A4B, FP8 | yes, ~29 GB weights | no | **The workshop model.** 3.8B active per token, so it decodes fast under batching; Whisper handles audio |
| 31B Dense, FP8 | yes, ~35 GB | no | Stronger, but every token touches all 31B: slower per user on a bandwidth-bound box |
| E4B | yes, ~9 GB | yes | Could do STT itself, but is noticeably weaker at tool calling than the 26B |

All of it lives on the Spark. Attendee laptops never load a model.

## Sources

- [Gemma 4 model overview](https://ai.google.dev/gemma/docs/core)
- [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)
- [Gemma 4 announcement](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
- [vLLM Gemma 4 recipe](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html)
