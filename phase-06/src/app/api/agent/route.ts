import { openAgentStream, toolsConfigured, toolsHealth } from "@/lib/tools";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type IncomingMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export async function GET() {
  const health = await toolsHealth();
  return NextResponse.json(health, { status: health.ok ? 200 : 502 });
}

/** Proxies the tools agent (Gemma + MCP tools) as server-sent events. */
export async function POST(request: Request) {
  if (!toolsConfigured()) {
    return NextResponse.json(
      { error: "Tools service is not configured (set TOOLS_BASE_URL)" },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as { messages?: IncomingMessage[] };
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          Boolean(m) &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          Boolean(m.content.trim()),
      )
      .map((m) => ({ role: m.role, content: m.content.trim() }));

    if (messages.length === 0) {
      return NextResponse.json(
        { error: "Expected non-empty `messages` array" },
        { status: 400 },
      );
    }

    const upstream = await openAgentStream(messages, request.signal);
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Tools service failed (${upstream.status})`,
          detail: detail.slice(0, 800),
        },
        { status: 502 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return NextResponse.json(
      {
        error: "Tools service unreachable",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
