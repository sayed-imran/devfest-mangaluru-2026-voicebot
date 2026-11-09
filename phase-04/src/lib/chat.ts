export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatHealth = {
  ok: boolean;
  model?: string;
  error?: string;
};

export async function checkLlmHealth(): Promise<ChatHealth> {
  try {
    const res = await fetch("/api/chat", { cache: "no-store" });
    return (await res.json()) as ChatHealth;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type ChatDelivery = "speak-all" | "handoff";

/**
 * Streams an assistant reply from POST /api/chat.
 * Calls onDelta for each text chunk; returns the full assistant text.
 */
export async function streamChat(
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
  delivery: ChatDelivery = "speak-all",
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, delivery }),
    signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(data.detail || data.error || `Chat failed (${res.status})`);
  }

  if (!res.body) {
    throw new Error("No response body from chat API");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  return full.trim();
}
