import type { ChatMessage } from "@/lib/chat";

export type ToolActivity = {
  id: string;
  name: string;
  title: string;
  status: "running" | "ok" | "error";
  detail?: string;
  message?: string;
  url?: string | null;
  dryRun?: boolean;
};

export type AgentEvent =
  | {
      type: "tool_call";
      id: string;
      name: string;
      title: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      title: string;
      ok: boolean;
      message: string;
      url?: string | null;
      dry_run?: boolean;
    }
  | { type: "final"; text: string; steps?: number; fast?: boolean }
  | { type: "error"; message: string };

export type ToolsHealth = {
  ok: boolean;
  configured?: boolean;
  os?: string;
  tools?: number;
  dry_run?: boolean;
  desktop?: { can_open: boolean; detail: string };
  error?: string;
};

export async function checkToolsHealth(): Promise<ToolsHealth> {
  try {
    const res = await fetch("/api/agent", { cache: "no-store" });
    return (await res.json()) as ToolsHealth;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const DETAIL_KEYS = ["query", "site", "place", "destination", "subject", "app", "to"];

/** Short human summary of tool arguments, e.g. `"lofi hip hop"`. */
export function summarizeArguments(args: Record<string, unknown>): string {
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/_/g, " ");
      return text.length > 60 ? `${text.slice(0, 57)}…` : text;
    }
  }
  return "";
}

/**
 * Runs the tools agent via POST /api/agent (SSE). Calls onEvent for tool
 * activity and resolves with the final spoken reply.
 */
export async function runAgent(
  messages: ChatMessage[],
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messages.filter((m) => m.role !== "system"),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(data.detail || data.error || `Tools failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let event: AgentEvent;
      try {
        event = JSON.parse(payload) as AgentEvent;
      } catch {
        continue;
      }
      if (event.type === "error") throw new Error(event.message);
      onEvent(event);
      if (event.type === "final") {
        await reader.cancel().catch(() => undefined);
        return event.text.trim();
      }
    }
  }

  throw new Error("Tools service ended without a reply");
}
