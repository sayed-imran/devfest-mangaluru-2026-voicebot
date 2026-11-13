/**
 * Thin client for self-hosted Laya (`laya-serve` → POST /v1/systemone).
 * Decides delivery from the *user request*, before the LLM finishes.
 * https://github.com/NandhaKishorM/laya
 */

const LAYA_BASE_URL = process.env.LAYA_BASE_URL ?? "http://spark-065b.local:8002";
const LAYA_TIMEOUT_MS = Number(process.env.LAYA_TIMEOUT_MS ?? 2500);
const LAYA_DETAIL_THRESHOLD = Number(process.env.LAYA_SPEAK_THRESHOLD ?? 0.55);

export type LayaDeliveryDecision = {
  /** true → fully speak the (expected short) reply; false → chat handoff */
  speakFully: boolean;
  confidence: number;
  choice?: string;
  raw?: unknown;
};

/** Intent questions over the user utterance only. */
const USER_INTENT_QUESTIONS = {
  delivery: {
    type: "choice" as const,
    instructions:
      "A voice assistant just heard this user request. Should it plan to speak the eventual answer fully aloud, or only give a short spoken cue and put a detailed answer in chat?",
    criteria: {
      speak:
        "User wants a short conversational reply: greeting, thanks, yes/no, quick fact, status, or a one-sentence clarification. Comfortable to hear in under ~12 seconds.",
      handoff:
        "User is asking for something long or dense: essay, report, detailed explanation, tutorial, list, comparison, history overview, code, or anything that would be tedious to hear in full. When unsure, choose handoff.",
    },
  },
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
        delivery?: {
          choice?: string;
          answer_confidence?: number;
          confidence?: number;
        };
        needs_detailed_writeup?: {
          noul?: number;
          answer_confidence?: number;
        };
      };
    };

    const choice = data.answers?.delivery?.choice?.toLowerCase();
    const detailNoul = Number(
      data.answers?.needs_detailed_writeup?.noul ?? NaN,
    );
    const detailThreshold = Number.isFinite(LAYA_DETAIL_THRESHOLD)
      ? LAYA_DETAIL_THRESHOLD
      : 0.55;

    let speakFully: boolean;
    let confidence: number;

    if (choice === "speak" || choice === "handoff") {
      const choiceSaysSpeak = choice === "speak";
      const detailSaysHandoff =
        Number.isFinite(detailNoul) && detailNoul >= detailThreshold;
      // Speak only when choice says speak AND the request does not look detailed.
      speakFully = choiceSaysSpeak && !detailSaysHandoff;
      confidence = Number(
        data.answers?.delivery?.answer_confidence ??
          data.answers?.delivery?.confidence ??
          (Number.isFinite(detailNoul) ? 1 - detailNoul : 0.5),
      );
    } else if (Number.isFinite(detailNoul)) {
      speakFully = detailNoul < detailThreshold;
      confidence = detailNoul;
    } else {
      return null;
    }

    return {
      speakFully,
      confidence,
      choice: choice ?? (speakFully ? "speak" : "handoff"),
      raw: data.answers,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
