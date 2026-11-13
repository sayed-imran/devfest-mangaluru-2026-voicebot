/**
 * Thin client for self-hosted Laya (`laya-serve` → POST /v1/systemone).
 * Decides delivery from the *user request*, before the LLM finishes.
 * https://github.com/NandhaKishorM/laya
 */

import { strongHandoffCue } from "@/lib/partition";

const LAYA_BASE_URL = process.env.LAYA_BASE_URL ?? "http://spark-065b.local:8002";
const LAYA_TIMEOUT_MS = Number(process.env.LAYA_TIMEOUT_MS ?? 2500);
/** Laya's "needs a detailed write-up" score at or above this → handoff to chat. */
const LAYA_DETAIL_THRESHOLD = Number(process.env.LAYA_SPEAK_THRESHOLD ?? 0.5);

export type LayaDeliveryDecision = {
  /** true → fully speak the (expected short) reply; false → chat handoff */
  speakFully: boolean;
  confidence: number;
  choice?: string;
  raw?: unknown;
};

/**
 * One question over the user utterance only.
 *
 * An earlier version also asked a speak-vs-handoff "choice" question whose criteria said
 * "when unsure, choose handoff". Measured on the Spark it chose handoff for almost every
 * plain question ("What is the capital of Karnataka?", "Who wrote Malgudi Days?") at ~0.55
 * confidence, and doubled Laya's latency (~1 s vs ~0.2 s). This score alone separates
 * quick facts (≈0.1-0.25) from write-ups (≈0.6+); strongHandoffCue covers explicit
 * long-form requests (code, lists, comparisons) that the score under-rates.
 */
const USER_INTENT_QUESTIONS = {
  needs_detailed_writeup: {
    type: "noul" as const,
    instructions:
      "Is the user asking for a long, detailed, or reading-oriented answer that belongs in chat rather than being spoken word-for-word?",
  },
};

export async function checkLayaHealth(): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const res = await fetch(`${LAYA_BASE_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { ok: false, error: `Laya unhealthy (${res.status})` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ask Laya (from the user utterance) whether Gemma should speak the full
 * answer or hand off to chat. Returns null on timeout / offline.
 */
export async function decideDeliveryFromUser(options: {
  userText: string;
  signal?: AbortSignal;
}): Promise<LayaDeliveryDecision | null> {
  const user = options.userText.trim();
  if (!user) {
    return { speakFully: true, confidence: 1 };
  }

  const timeoutMs = Number.isFinite(LAYA_TIMEOUT_MS)
    ? Math.max(300, LAYA_TIMEOUT_MS)
    : 2500;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(`${LAYA_BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { user_request: user },
        questions: USER_INTENT_QUESTIONS,
        model: "english",
        lang: "en",
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      answers?: {
        needs_detailed_writeup?: { noul?: number };
      };
    };

    const detailNoul = Number(data.answers?.needs_detailed_writeup?.noul ?? NaN);
    if (!Number.isFinite(detailNoul)) return null;

    const detailThreshold = Number.isFinite(LAYA_DETAIL_THRESHOLD)
      ? LAYA_DETAIL_THRESHOLD
      : 0.5;
    const cue = strongHandoffCue(user);
    const speakFully = detailNoul < detailThreshold && !cue;

    return {
      speakFully,
      confidence: speakFully ? 1 - detailNoul : Math.max(detailNoul, cue ? 0.9 : 0),
      choice: speakFully ? "speak" : cue ? "handoff (long-form cue)" : "handoff",
      raw: data.answers,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
