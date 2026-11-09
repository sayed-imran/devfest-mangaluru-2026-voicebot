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
};

/**
 * Ask the server (Laya on the user utterance) how Gemma should deliver
 * the upcoming answer — before the LLM finishes.
 */
export async function requestDeliveryIntent(
  userText: string,
  options?: { signal?: AbortSignal },
): Promise<DeliveryIntentResponse> {
  try {
    const res = await fetch("/api/partition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userText }),
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
