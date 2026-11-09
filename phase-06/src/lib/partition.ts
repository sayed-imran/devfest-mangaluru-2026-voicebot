export type PartitionMode = "speak-all" | "handoff";

/** "action" runs the tools agent (MCP); "chat" is a plain LLM reply. */
export type TurnRoute = "chat" | "action";

export type DeliveryIntent = {
  mode: PartitionMode;
  /** Spoken line for handoff mode (empty for speak-all until the reply exists). */
  speak: string;
  decidedBy: "laya" | "heuristic";
  route?: TurnRoute;
};

export type PartitionedReply = {
  speak: string;
  display: string;
  mode: PartitionMode;
  decidedBy?: "laya" | "heuristic";
};

const DEFAULT_MAX_SPEAK_WORDS = 45;
const HARD_MAX_SPEAK_WORDS = 80;

/** Present-tense lines — spoken while the full answer may still be streaming. */
const HANDOFF_LINES = [
  "I'll put the detailed answer in the chat for you.",
  "I'm writing that up in the chat so you can read it properly.",
  "You'll see the full answer in the chat in a moment.",
];

export function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function pickHandoffLine() {
  return (
    HANDOFF_LINES[Math.floor(Math.random() * HANDOFF_LINES.length)] ??
    HANDOFF_LINES[0]
  );
}

/**
 * Guess from the *user request* whether the answer should be chat-first.
 * Used when Laya is offline.
 */
export function heuristicUserWantsHandoff(userText: string): boolean {
  const cleaned = userText.trim();
  if (!cleaned) return false;

  const t = cleaned.toLowerCase();
  const words = wordCount(cleaned);

  if (
    /\b(essay|report|write[- ]?up|blog|article|documentation|detailed|in detail|thorough|comprehensive|long[- ]form|\d{3,}\s*words?|bullet|step[- ]by[- ]step|tutorial|walkthrough|implement|architecture|code sample|source code)\b/.test(
      t,
    )
  ) {
    return true;
  }

  if (
    /\b(tell me about|explain|describe|summarize|compare|history of|how (do|does|can|to)|what (are|is) the)\b/.test(
      t,
    ) &&
    words >= 3
  ) {
    return true;
  }

  if (words >= 35) return true;

  if (
    words <= 8 &&
    /\b(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye|good (morning|night)|how are you)\b/.test(
      t,
    )
  ) {
    return false;
  }

  return false;
}

/** Safety net on a finished assistant reply (speak-all path only). */
export function heuristicShouldHandoff(
  text: string,
  maxSpeakWords = DEFAULT_MAX_SPEAK_WORDS,
): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;

  const words = wordCount(cleaned);
  if (words > maxSpeakWords) return true;
  if (words <= 14) return false;

  if (/```/.test(cleaned)) return true;
  if (/(?:^|\n)\s{0,3}#{1,6}\s/m.test(cleaned)) return true;
  if (/(?:^|\n)\s*(?:[-*•]|\d+\.)\s+\S/m.test(cleaned)) return true;
  if (cleaned.split(/\n\s*\n/).filter(Boolean).length >= 3) return true;

  return false;
}

export function deliveryIntentHeuristic(userText: string): DeliveryIntent {
  if (heuristicUserWantsHandoff(userText)) {
    return {
      mode: "handoff",
      speak: pickHandoffLine(),
      decidedBy: "heuristic",
      route: "chat",
    };
  }
  return { mode: "speak-all", speak: "", decidedBy: "heuristic", route: "chat" };
}

/**
 * After a speak-all generation, optionally downgrade to handoff if the
 * model still produced something too long to read aloud.
 */
export function applySpeakDecision(
  text: string,
  preferSpeak: boolean,
  maxSpeakWords = DEFAULT_MAX_SPEAK_WORDS,
): PartitionedReply {
  const cleaned = text.trim();
  if (!cleaned) {
    return {
      speak: "",
      display: "",
      mode: "speak-all",
      decidedBy: preferSpeak ? "laya" : "heuristic",
    };
  }

  const words = wordCount(cleaned);
  const structuralDump =
    /```/.test(cleaned) ||
    /(?:^|\n)\s{0,3}#{1,6}\s/m.test(cleaned) ||
    /(?:^|\n)\s*(?:[-*•]|\d+\.)\s+\S/m.test(cleaned) ||
    cleaned.split(/\n\s*\n/).filter(Boolean).length >= 3;

  const forceHandoff =
    !preferSpeak ||
    words > maxSpeakWords ||
    words > HARD_MAX_SPEAK_WORDS ||
    structuralDump;

  if (!forceHandoff) {
    return {
      speak: cleaned,
      display: "",
      mode: "speak-all",
      decidedBy: "laya",
    };
  }

  return {
    speak: pickHandoffLine(),
    display: cleaned,
    mode: "handoff",
    decidedBy: preferSpeak ? "laya" : "heuristic",
  };
}
