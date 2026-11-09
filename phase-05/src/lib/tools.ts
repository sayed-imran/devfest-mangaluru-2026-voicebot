/**
 * Server-side client for the Python tools service (FastAPI + MCP).
 * Only Next.js API routes call it; the browser never reaches it directly.
 */

const TOOLS_BASE_URL = (process.env.TOOLS_BASE_URL ?? "").trim().replace(/\/+$/, "");
const TOOLS_API_KEY = (process.env.TOOLS_API_KEY ?? "").trim();
const TOOLS_TIMEOUT_MS = (() => {
  const n = Number(process.env.TOOLS_TIMEOUT_MS ?? 4000);
  return Number.isFinite(n) ? Math.max(500, n) : 4000;
})();
/** After a network failure, skip routing for a while so turns don't wait on a dead host. */
const RETRY_AFTER_MS = 30_000;

let unreachableUntil = 0;

export type ToolsRoute = {
  route: "action" | "chat";
  decided_by: "laya" | "rules";
  confidence: number;
  rule: string | null;
  laya: { ok: boolean; p_action?: number; latency_ms?: number; error?: string };
};

export type ToolsHealth = {
  ok: boolean;
  configured: boolean;
  os?: string;
  tools?: number;
  dry_run?: boolean;
  desktop?: { os: string; can_open: boolean; detail: string };
  servers?: { name: string; connected: boolean; tools: number; error: string | null }[];
  error?: string;
};

export function toolsConfigured() {
  return Boolean(TOOLS_BASE_URL);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return TOOLS_API_KEY
    ? { Authorization: `Bearer ${TOOLS_API_KEY}`, ...extra }
    : extra;
}

function withTimeout(ms: number, outer?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    },
  };
}

/** Laya-backed action-vs-chat decision; null when tools are off or unreachable. */
export async function routeTurn(options: {
  userText: string;
  lastAssistant?: string;
  signal?: AbortSignal;
}): Promise<ToolsRoute | null> {
  if (!TOOLS_BASE_URL || Date.now() < unreachableUntil) return null;
  const timeout = withTimeout(TOOLS_TIMEOUT_MS, options.signal);
  try {
    const res = await fetch(`${TOOLS_BASE_URL}/v1/route`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        text: options.userText,
        last_assistant: options.lastAssistant ?? "",
      }),
      cache: "no-store",
      signal: timeout.signal,
    });
    unreachableUntil = 0;
    if (!res.ok) return null;
    const data = (await res.json()) as ToolsRoute;
    return data.route === "action" || data.route === "chat" ? data : null;
  } catch (error) {
    if (!options.signal?.aborted) {
      unreachableUntil = Date.now() + RETRY_AFTER_MS;
      console.warn(
        `Tools service unreachable at ${TOOLS_BASE_URL}:`,
        error instanceof Error ? error.message : error,
      );
    }
    return null;
  } finally {
    timeout.done();
  }
}

export async function toolsHealth(): Promise<ToolsHealth> {
  if (!TOOLS_BASE_URL) {
    return { ok: false, configured: false, error: "TOOLS_BASE_URL is not set" };
  }
  const timeout = withTimeout(2500);
  try {
    const res = await fetch(`${TOOLS_BASE_URL}/health`, {
      headers: headers(),
      cache: "no-store",
      signal: timeout.signal,
    });
    if (!res.ok) {
      return { ok: false, configured: true, error: `Tools service returned ${res.status}` };
    }
    unreachableUntil = 0;
    const data = (await res.json()) as Omit<ToolsHealth, "configured">;
    return { ...data, configured: true };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      error: `Tools service unreachable at ${TOOLS_BASE_URL} (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    timeout.done();
  }
}

export function openAgentStream(
  messages: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
) {
  return fetch(`${TOOLS_BASE_URL}/v1/agent`, {
    method: "POST",
    headers: headers({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    }),
    body: JSON.stringify({ messages, stream: true }),
    cache: "no-store",
    signal,
  });
}
