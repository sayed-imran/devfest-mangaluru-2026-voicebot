import {
  deliveryIntentHeuristic,
  type DeliveryIntent,
} from "@/lib/partition";

export type DeliveryIntentResponse = DeliveryIntent & {
  laya?: {
    ok: boolean;
    speakFully?: boolean;
    confidence?: number;
    choice?: string;
  };
  routing?: {
    ok: boolean;
    route?: "chat" | "action";
    decidedBy?: "laya" | "rules";
    confidence?: number;
    rule?: string | null;
    pAction?: number | null;
  };
};

/**
 * Ask the server how Gemma should handle the upcoming turn — computer action
 * (tools) or chat, and for chat speak-all vs handoff — before the LLM finishes.
 */
export async function requestDeliveryIntent(
  userText: string,
  options?: { signal?: AbortSignal; lastAssistant?: string },
): Promise<DeliveryIntentResponse> {
  try {
    const res = await fetch("/api/partition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userText,
        lastAssistant: options?.lastAssistant ?? "",
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      return deliveryIntentHeuristic(userText);
    }

    const data = (await res.json()) as DeliveryIntentResponse;
    if (data.mode !== "speak-all" && data.mode !== "handoff") {
      return deliveryIntentHeuristic(userText);
    }
    return data;
  } catch {
    return deliveryIntentHeuristic(userText);
  }
}
