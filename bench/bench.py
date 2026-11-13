#!/usr/bin/env python3
"""
Benchmark one OpenAI-compatible endpoint: prefill, decode and time-to-first-token.

Run it at a few concurrency levels against the Spark, keep the JSON, then compare:

    python bench.py --label "1 user"    --concurrency 1
    python bench.py --label "8 users"   --concurrency 8
    python bench.py --label "30 users"  --concurrency 30

    python bench.py --compare results/*.json

What is measured, per prompt, over the streaming chat-completions API:

  ttft_s          seconds from request sent to the first content token
  decode_tok_s    output tokens / (total - ttft)       — how fast it talks
  prefill_tok_s   prompt tokens / ttft                 — how fast it reads
  total_s         wall clock for the whole response

Decode rate is what the room *hears*. Prefill matters when you paste in a long
document. TTFT is what makes a voice agent feel alive or dead, and it is the
number worth putting on a slide.

Token counts come from the server's `usage` block when it sends one. Streaming
responses often omit it, so the script asks for `stream_options.include_usage`
and falls back to counting characters / 4 when the server ignores that. The
fallback is flagged in the output — do not quote estimated numbers as measured.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

# Short, medium and long prompts: the shape of the prompt changes prefill a lot
# and decode very little, which is itself a point worth making in the talk.
DEFAULT_PROMPTS = [
    ("short", "Say hello and tell me the time of day in five words."),
    (
        "turn",
        "I just walked into a workshop about running language models offline. "
        "Give me a two-sentence explanation of why that matters.",
    ),
    (
        "long",
        "Here are notes from a meeting:\n\n"
        + (
            "- The team agreed to move inference on-device for the privacy review.\n"
            "- Latency budget is 300ms to first audio.\n"
            "- Memory budget on the target device is 8GB total.\n"
            "- Legal wants Apache 2.0 or similar.\n"
            "- The demo is in three weeks.\n"
        )
        * 6
        + "\nSummarise the decisions and list the open risks.",
    ),
]

VOICE_SYSTEM_PROMPT = (
    "You are a voice assistant. Keep answers short and conversational, "
    "ideally under three sentences."
)


@dataclass
class Sample:
    prompt_id: str
    ttft_s: float
    total_s: float
    prompt_tokens: int
    output_tokens: int
    prefill_tok_s: float
    decode_tok_s: float
    estimated_tokens: bool


def _post_stream(base_url: str, model: str, prompt: str, max_tokens: int, timeout: float):
    """Yield (timestamp, event_dict) for each SSE data frame."""
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": VOICE_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "stream": True,
            "stream_options": {"include_usage": True},
            "temperature": 0.0,
            "max_tokens": max_tokens,
        }
    ).encode()

    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                return
            try:
                yield time.perf_counter(), json.loads(payload)
            except json.JSONDecodeError:
                continue


def run_prompt(
    base_url: str, model: str, prompt_id: str, prompt: str, max_tokens: int, timeout: float
) -> Sample:
    start = time.perf_counter()
    ttft: float | None = None
    text_parts: list[str] = []
    usage: dict | None = None

    for stamp, event in _post_stream(base_url, model, prompt, max_tokens, timeout):
        if event.get("usage"):
            usage = event["usage"]
        for choice in event.get("choices") or []:
            delta = (choice.get("delta") or {}).get("content") or ""
            if delta:
                if ttft is None:
                    ttft = stamp - start
                text_parts.append(delta)

    total = time.perf_counter() - start
    if ttft is None:
        raise RuntimeError(f"[{prompt_id}] no content tokens came back")

    text = "".join(text_parts)
    estimated = usage is None
    if usage:
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("completion_tokens") or 0)
    else:
        # ~4 characters per token is close enough for a relative comparison and
        # wrong enough that it must never be presented as a measurement.
        prompt_tokens = max(1, len(prompt) // 4)
        output_tokens = max(1, len(text) // 4)

    decode_window = max(total - ttft, 1e-6)
    return Sample(
        prompt_id=prompt_id,
        ttft_s=round(ttft, 4),
        total_s=round(total, 4),
        prompt_tokens=prompt_tokens,
        output_tokens=output_tokens,
        prefill_tok_s=round(prompt_tokens / max(ttft, 1e-6), 1),
        decode_tok_s=round(output_tokens / decode_window, 1),
        estimated_tokens=estimated,
    )


def bench(args) -> dict:
    prompts = DEFAULT_PROMPTS
    if args.prompt:
        prompts = [("custom", args.prompt)]

    print(f"Endpoint : {args.base_url}")
    print(f"Model    : {args.model}")
    print(f"Label    : {args.label}")
    print(f"Parallel : {args.concurrency} simultaneous requests")
    print(f"Warmup   : {args.warmup}, runs per prompt: {args.runs}\n")

    for _ in range(args.warmup):
        print("  warming up ...")
        run_prompt(args.base_url, args.model, "warmup", "Hi.", 16, args.timeout)

    samples: list[Sample] = []
    for prompt_id, prompt in prompts:
        for run in range(args.runs):
            # N requests fired together: what one attendee sees while the room is also talking.
            with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                batch = list(
                    pool.map(
                        lambda _: run_prompt(
                            args.base_url, args.model, prompt_id, prompt,
                            args.max_tokens, args.timeout,
                        ),
                        range(args.concurrency),
                    )
                )
            samples.extend(batch)
            sample = batch[len(batch) // 2] if len(batch) > 1 else batch[0]
            ttft = statistics.median(b.ttft_s for b in batch)
            decode = statistics.median(b.decode_tok_s for b in batch)
            prefill = statistics.median(b.prefill_tok_s for b in batch)
            flag = " (tokens estimated)" if sample.estimated_tokens else ""
            print(
                f"  {prompt_id:<6} run {run + 1}/{args.runs}  "
                f"ttft {ttft * 1000:7.0f} ms   "
                f"decode {decode:6.1f} tok/s   "
                f"prefill {prefill:7.1f} tok/s   "
                f"(median of {len(batch)}){flag}"
            )

    def med(attr: str) -> float:
        return round(statistics.median(getattr(s, attr) for s in samples), 2)

    result = {
        "label": args.label,
        "model": args.model,
        "base_url": args.base_url,
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "python": platform.python_version(),
        },
        "notes": args.notes,
        "concurrency": args.concurrency,
        "median": {
            "ttft_ms": round(statistics.median(s.ttft_s for s in samples) * 1000, 1),
            "ttft_p95_ms": round(
                sorted(s.ttft_s for s in samples)[int(0.95 * (len(samples) - 1))] * 1000, 1
            ),
            "decode_tok_s": med("decode_tok_s"),
            "prefill_tok_s": med("prefill_tok_s"),
            "total_s": med("total_s"),
        },
        "tokens_estimated": any(s.estimated_tokens for s in samples),
        "samples": [asdict(s) for s in samples],
    }

    print("\n  median ttft     %.0f ms" % result["median"]["ttft_ms"])
    print("  p95 ttft        %.0f ms" % result["median"]["ttft_p95_ms"])
    print("  median decode   %.1f tok/s" % result["median"]["decode_tok_s"])
    print("  median prefill  %.1f tok/s" % result["median"]["prefill_tok_s"])
    if result["tokens_estimated"]:
        print("\n  NOTE: the server sent no usage block; token counts are estimated")
        print("        from character length. Do not quote these as measured.")

    return result


def compare(paths: list[str]) -> None:
    rows = []
    for pattern in paths:
        for path in sorted(glob.glob(pattern)):
            with open(path) as fh:
                rows.append(json.load(fh))

    if not rows:
        print("No result files matched.", file=sys.stderr)
        raise SystemExit(1)

    head = (
        f"| {'Run':<22} | {'Model':<12} | {'Users':>5} | {'TTFT':>9} | {'p95 TTFT':>9} "
        f"| {'Decode':>12} | {'Prefill':>13} |"
    )
    rule = (
        f"| {'-' * 22} | {'-' * 12} | {'-' * 5} | {'-' * 9} | {'-' * 9} "
        f"| {'-' * 12} | {'-' * 13} |"
    )
    print(head)
    print(rule)
    for row in rows:
        m = row["median"]
        star = " *" if row.get("tokens_estimated") else ""
        print(
            f"| {row['label'][:22]:<22} | {row['model'][:12]:<12} | "
            f"{row.get('concurrency', 1):>5} | {m['ttft_ms']:>6.0f} ms | "
            f"{m.get('ttft_p95_ms', m['ttft_ms']):>6.0f} ms | {m['decode_tok_s']:>6.1f} tok/s | "
            f"{m['prefill_tok_s']:>7.1f} tok/s |{star}"
        )
    if any(r.get("tokens_estimated") for r in rows):
        print("\n* token counts estimated from character length, not reported by the server")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark prefill, decode and TTFT on an OpenAI-compatible endpoint.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", "http://spark-065b.local:8081"))
    parser.add_argument("--model", default=os.environ.get("LLM_MODEL", "gemma4-26b"))
    parser.add_argument("--label", default=platform.node() or "this machine",
                        help="How this machine appears in the comparison table")
    parser.add_argument("--concurrency", type=int, default=1,
                        help="Simultaneous requests per run, to simulate the room (default 1)")
    parser.add_argument("--runs", type=int, default=3, help="Runs per prompt (default 3)")
    parser.add_argument("--warmup", type=int, default=1, help="Warmup requests (default 1)")
    parser.add_argument("--max-tokens", type=int, default=160)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--prompt", help="Benchmark one custom prompt instead of the built-in set")
    parser.add_argument("--notes", default="", help="Free text stored with the result")
    parser.add_argument("--out", help="Write JSON here (default results/<label>-<model>.json)")
    parser.add_argument("--compare", nargs="+", metavar="FILE",
                        help="Print a comparison table from saved result files and exit")
    args = parser.parse_args()

    if args.compare:
        compare(args.compare)
        return

    try:
        result = bench(args)
    except urllib.error.URLError as exc:
        print(f"\nCould not reach {args.base_url}: {exc}", file=sys.stderr)
        print("Is the Spark up? Try ./spark/smoke.sh spark-065b.local", file=sys.stderr)
        raise SystemExit(1)

    out = args.out
    if not out:
        safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in args.label.lower())
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", f"{safe}-{args.model}-c{args.concurrency}.json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(result, fh, indent=2)
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
