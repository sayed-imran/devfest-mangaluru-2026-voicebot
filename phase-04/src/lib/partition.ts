export type PartitionMode = "speak-all" | "handoff";

export type DeliveryIntent = {
  mode: PartitionMode;
  /** Spoken line for handoff mode (empty for speak-all until the reply exists). */
  speak: string;
  decidedBy: "laya" | "heuristic";
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

const NUMBER_WORDS =
  "four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|[4-9]|[1-9]\\d{1,2}";

/**
 * Explicit long-form requests: the user has asked for something that is tedious to hear
 * read aloud, whatever Laya's score says. Plain questions ("what is the capital of…",
 * "how do I…") are deliberately NOT here: those should be spoken, and the safety net in
 * applySpeakDecision still hands off if the reply turns out long or structured.
 */
export function strongHandoffCue(userText: string): boolean {
  const t = userText.trim().toLowerCase();
  if (!t) return false;

  const patterns = [
    // written artefacts
    /\b(essay|report|write[- ]?up|blog( post)?|article|documentation|cover letter|long[- ]form)\b/,
    /\b(in detail|detailed|thorough(ly)?|comprehensive|in depth|step[- ]by[- ]step|tutorial|walkthrough)\b/,
    /\b\d{3,}\s*words?\b/,
    // code
    /\b(write|give|show|generate|create)\b.*\b(code|function|script|program|snippet|regex|sql|class|implementation)\b/,
    /\b(source code|code sample)\b/,
    // comparisons, overviews, summaries
    /\b(compare|comparison|pros and cons|difference between|differences between|vs\.?|versus)\b/,
    /\b(history of|overview of|summari[sz]e|summary of|key ideas)\b/,
    // long lists ("list ten…", "top 5…", "twenty places…"); short lists like "three tips" stay spoken
    new RegExp(`\\b(list|top)\\b.*\\b(${NUMBER_WORDS})\\b`),
    new RegExp(`\\b(${NUMBER_WORDS})\\s+(places|things|ways|tips|ideas|steps|examples|reasons|books|movies|questions)\\b`),
  ];

  return patterns.some((re) => re.test(t));
}

/**
 * Fallback when Laya is offline or slow: explicit long-form cues, or a very long request.
 */
export function heuristicUserWantsHandoff(userText: string): boolean {
  const cleaned = userText.trim();
  if (!cleaned) return false;
  if (strongHandoffCue(cleaned)) return true;
  return wordCount(cleaned) >= 35;
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
    };
  }
  return { mode: "speak-all", speak: "", decidedBy: "heuristic" };
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
