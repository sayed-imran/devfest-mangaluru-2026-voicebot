import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Two routes to text, selected by STT_MODE:
 *
 *   gemma   — Gemma 4 E2B/E4B take audio natively, so LiteRT-LM transcribes on the
 *             same server that does the reasoning. One model, one less hop, and
 *             nothing extra to run on a laptop. This is the workshop default.
 *   whisper — the classic OpenAI-compatible /v1/audio/transcriptions endpoint
 *             (vLLM, faster-whisper, …). Needs a second service, usually on a GPU box.
 *
 * Both return { text, model } so the client never has to care which one ran.
 */

const STT_MODE = (process.env.STT_MODE ?? "gemma").trim().toLowerCase();
const STT_LANGUAGE = process.env.STT_LANGUAGE ?? "en";

const GEMMA_BASE_URL = (process.env.STT_GEMMA_BASE_URL ?? "http://127.0.0.1:8081")
  .trim()
  .replace(/\/+$/, "");
const GEMMA_MODEL = process.env.STT_GEMMA_MODEL ?? "gemma4-e4b";

const WHISPER_BASE_URL = (process.env.STT_BASE_URL ?? "http://localhost:8001")
  .trim()
  .replace(/\/+$/, "");
const WHISPER_MODEL = process.env.STT_MODEL ?? "openai/whisper-large-v3-turbo";

const usingGemma = STT_MODE !== "whisper";
const activeBaseUrl = usingGemma ? GEMMA_BASE_URL : WHISPER_BASE_URL;
const activeModel = usingGemma ? GEMMA_MODEL : WHISPER_MODEL;

/** Keeps the model transcribing instead of answering what it just heard. */
function transcribePrompt(language: string) {
  return [
    "Transcribe the attached audio verbatim.",
    `The speaker is using the language with ISO-639-1 code "${language}".`,
    "Return only the transcript text.",
    "Do not translate, summarise, answer, or add quotation marks, labels or commentary.",
    "If there is no intelligible speech, return exactly: (no speech detected)",
  ].join(" ");
}

export async function GET() {
  try {
    const res = await fetch(`${activeBaseUrl}/v1/models`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, mode: STT_MODE, error: `STT unreachable (${res.status})` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    return NextResponse.json({
      ok: true,
      mode: usingGemma ? "gemma" : "whisper",
      model: activeModel,
      models: data.data?.map((m) => m.id) ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        mode: STT_MODE,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

/** Strip the wrappers a chat model sometimes puts around a transcript. */
function cleanTranscript(raw: string) {
  let text = raw.trim();
  text = text.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "");
  text = text.replace(/^(?:transcript|transcription)\s*:\s*/i, "");
  if (text.length > 1 && /^["“'].*["”']$/s.test(text)) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

async function transcribeWithGemma(file: File, language: string) {
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  const res = await fetch(`${GEMMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: transcribePrompt(language) },
            {
              type: "input_audio",
              input_audio: { data: base64, format: "wav" },
            },
          ],
        },
      ],
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemma audio transcription failed (${res.status}): ${raw.slice(0, 500)}`);
  }

  let parsed: { choices?: { message?: { content?: string } }[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON from LiteRT-LM: ${raw.slice(0, 500)}`);
  }

  return cleanTranscript(parsed.choices?.[0]?.message?.content ?? "");
}

async function transcribeWithWhisper(file: File, language: string) {
  const upstream = new FormData();
  upstream.append("file", file, file.name || "speech.wav");
  upstream.append("model", WHISPER_MODEL);
  upstream.append("response_format", "json");
  upstream.append("language", language);

  const res = await fetch(`${WHISPER_BASE_URL}/v1/audio/transcriptions`, {
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

    const text = usingGemma
      ? await transcribeWithGemma(file, language)
      : await transcribeWithWhisper(file, language);

    return NextResponse.json({
      text,
      model: activeModel,
      mode: usingGemma ? "gemma" : "whisper",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Transcription failed", detail: message.slice(0, 800) },
      { status: 502 },
    );
  }
}
