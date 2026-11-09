/**
 * Detect hard stop / cancel utterances that should abort Gemma immediately
 * and must NOT spawn a new LLM turn.
 */
export function isHardStopCommand(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  const words = t.split(" ").filter(Boolean);
  // Long requests aren't pure stop commands.
  if (words.length > 18) return false;

  if (
    /^(please\s+)?(just\s+)?(stop|stop\s+it|stop\s+that|stop\s+talking|stop\s+speaking|shut\s+up|be\s+quiet|quiet|silence|enough|cancel|never\s*mind|thats\s+enough|that\s+is\s+enough|cut\s+it\s+out|halt|pause)(\s+please)?$/.test(
      t,
    )
  ) {
    return true;
  }

  // e.g. "Stop. I don't want to hear it. Stop."
  const hasStopWord = /\b(stop|shut\s+up|be\s+quiet|silence|enough|cancel)\b/.test(
    t,
  );
  const hasReject =
    /\b(dont|do\s+not|no\s+more|enough|hear\s+it|listening|talking|speaking)\b/.test(
      t,
    );
  if (hasStopWord && hasReject) return true;

  // Repeated stop tokens only: "stop stop stop"
  if (words.length <= 6 && words.every((w) => w === "stop" || w === "please")) {
    return true;
  }

  return false;
}

/** Rough check that STT heard Gemma instead of the user (speaker echo). */
export function looksLikeEcho(transcript: string, recentSpoken: string): boolean {
  const a = normalizeForCompare(transcript);
  const b = normalizeForCompare(recentSpoken);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.includes(a) && a.split(" ").length >= 3) return true;
  if (a.includes(b) && b.split(" ").length >= 4) return true;

  const aWords = new Set(a.split(" ").filter((w) => w.length > 2));
  const bWords = b.split(" ").filter((w) => w.length > 2);
  if (aWords.size < 3 || bWords.length < 3) return false;

  let overlap = 0;
  for (const w of bWords) {
    if (aWords.has(w)) overlap += 1;
  }
  return overlap / aWords.size >= 0.7;
}

function normalizeForCompare(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
