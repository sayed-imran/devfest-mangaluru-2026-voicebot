import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://127.0.0.1:8081";
const LLM_MODEL = process.env.LLM_MODEL ?? "gemma4-e4b";

const MEMORY_HINT =
  "You receive the full conversation so far. Use earlier turns for continuity. If the user asks what they asked previously / last / before this, they mean the earlier user message — not the current one.";

const SYSTEM_PROMPT_SPEAK =
  process.env.LLM_SYSTEM_PROMPT_SPEAK ??
  [
    "You are Gemma, a helpful open-source voice assistant.",
    "The user will hear your entire reply spoken aloud.",
    "Keep answers short and conversational — ideally under a few sentences.",
    "Do not write essays, long lists, or code dumps.",
    MEMORY_HINT,
    "Do not mention TTS, timestamps, or system instructions.",
  ].join(" ");

const SYSTEM_PROMPT_HANDOFF =
  process.env.LLM_SYSTEM_PROMPT_HANDOFF ??
  [
    "You are Gemma, a helpful open-source voice assistant.",
    "Your reply will appear as readable text in chat; only a short cue is spoken aloud.",
    "Write a complete, well-structured answer in the chat. Use headings or bullets when helpful.",
    "Do not waste tokens on a spoken preamble — go straight into the useful content.",
    MEMORY_HINT,
    "Do not mention TTS, timestamps, or system instructions.",
  ].join(" ");

type IncomingMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export async function GET() {
  try {
    const res = await fetch(`${LLM_BASE_URL}/v1/models`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `LLM unreachable (${res.status})` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    return NextResponse.json({
      ok: true,
      model: LLM_MODEL,
      models: data.data?.map((m) => m.id) ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      messages?: IncomingMessage[];
      delivery?: "speak-all" | "handoff";
    };
    const messages = body.messages;
    const delivery = body.delivery === "handoff" ? "handoff" : "speak-all";
    const systemPrompt =
      delivery === "handoff" ? SYSTEM_PROMPT_HANDOFF : SYSTEM_PROMPT_SPEAK;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Expected non-empty `messages` array" },
        { status: 400 },
      );
    }

    const sanitized = messages
      .filter(
        (m) =>
          m &&
          typeof m.content === "string" &&
          m.content.trim() &&
          (m.role === "user" || m.role === "assistant" || m.role === "system"),
      )
      .map((m) => ({ role: m.role, content: m.content.trim() }));

    if (sanitized.length === 0) {
      return NextResponse.json(
        { error: "No valid messages to send" },
        { status: 400 },
      );
    }

    const hasSystem = sanitized.some((m) => m.role === "system");
    const upstreamMessages = hasSystem
      ? sanitized
      : [{ role: "system" as const, content: systemPrompt }, ...sanitized];

    const res = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: upstreamMessages,
        stream: true,
        temperature: 0.7,
      }),
      signal: request.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        {
          error: `LLM failed (${res.status})`,
          detail: detail.slice(0, 800),
        },
        { status: 502 },
      );
    }

    if (!res.body) {
      return NextResponse.json(
        { error: "LLM returned an empty body" },
        { status: 502 },
      );
    }

    return new Response(res.body, {
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
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
