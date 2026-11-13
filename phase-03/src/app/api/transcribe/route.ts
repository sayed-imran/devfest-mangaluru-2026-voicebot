import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Speech-to-text runs on the DGX Spark: Whisper large-v3-turbo served by vLLM behind
 * the OpenAI-compatible /v1/audio/transcriptions endpoint. Nothing runs on the laptop;
 * this route just forwards the VAD clip and normalises the reply to { text, model }.
 */

const STT_LANGUAGE = process.env.STT_LANGUAGE ?? "en";
const STT_BASE_URL = (process.env.STT_BASE_URL ?? "http://spark-065b.local:8001")
  .trim()
  .replace(/\/+$/, "");
const STT_MODEL = process.env.STT_MODEL ?? "whisper-large-v3-turbo";

export async function GET() {
  try {
    const res = await fetch(`${STT_BASE_URL}/v1/models`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `STT unreachable (${res.status})` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    return NextResponse.json({
      ok: true,
      model: STT_MODEL,
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

async function transcribe(file: File, language: string) {
  const upstream = new FormData();
  upstream.append("file", file, file.name || "speech.wav");
  upstream.append("model", STT_MODEL);
  upstream.append("response_format", "json");
  upstream.append("language", language);

  const res = await fetch(`${STT_BASE_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: upstream,
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Whisper failed (${res.status}): ${raw.slice(0, 500)}`);
  }

  let parsed: { text?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Whisper JSON response: ${raw.slice(0, 500)}`);
  }

  return (parsed.text ?? "").trim();
}

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const file = incoming.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing audio file field `file`" },
        { status: 400 },
      );
    }

    const requested = incoming.get("language");
    const language =
      typeof requested === "string" && requested.trim()
        ? requested.trim()
        : STT_LANGUAGE;

    const text = await transcribe(file, language);
    return NextResponse.json({ text, model: STT_MODEL });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Transcription failed", detail: message.slice(0, 800) },
      { status: 502 },
    );
  }
}
