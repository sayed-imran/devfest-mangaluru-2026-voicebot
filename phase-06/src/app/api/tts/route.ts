import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TTS_BASE_URL = process.env.TTS_BASE_URL ?? "http://localhost:8880";
const TTS_VOICE = process.env.TTS_VOICE ?? "am_michael";
const TTS_MODEL = process.env.TTS_MODEL ?? "kokoro";
/** Kokoro speech rate. 1.0 = default; bump slightly for snappier replies. */
const TTS_SPEED = (() => {
  const n = Number(process.env.TTS_SPEED ?? 1.15);
  if (!Number.isFinite(n)) return 1.15;
  return Math.min(2, Math.max(0.5, n));
})();

type CaptionedTimestamp = {
  word?: string;
  start_time?: number;
  end_time?: number;
  start?: number;
  end?: number;
};

export async function GET() {
  try {
    const res = await fetch(`${TTS_BASE_URL}/v1/models`, {
      cache: "no-store",
    });
    if (!res.ok) {
      // Some Kokoro builds expose health elsewhere; still report voice config.
      const fallback = await fetch(`${TTS_BASE_URL}/web/`, {
        cache: "no-store",
      }).catch(() => null);
      if (fallback?.ok) {
        return NextResponse.json({ ok: true, voice: TTS_VOICE, model: TTS_MODEL });
      }
      return NextResponse.json(
        { ok: false, error: `TTS unreachable (${res.status})` },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      voice: TTS_VOICE,
      model: TTS_MODEL,
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
    const body = (await request.json()) as { text?: string; voice?: string };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "Missing `text`" }, { status: 400 });
    }

    const voice =
      typeof body.voice === "string" && body.voice.trim()
        ? body.voice.trim()
        : TTS_VOICE;

    const res = await fetch(`${TTS_BASE_URL}/dev/captioned_speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice,
        response_format: "mp3",
        stream: false,
        return_timestamps: true,
        speed: TTS_SPEED,
      }),
      signal: request.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        {
          error: `TTS failed (${res.status})`,
          detail: raw.slice(0, 800),
        },
        { status: 502 },
      );
    }

    let parsed: {
      audio?: string;
      audio_format?: string;
      timestamps?: CaptionedTimestamp[];
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return NextResponse.json(
        { error: "Invalid TTS JSON response", detail: raw.slice(0, 800) },
        { status: 502 },
      );
    }

    if (!parsed.audio) {
      return NextResponse.json(
        { error: "TTS returned empty audio" },
        { status: 502 },
      );
    }

    const timestamps = (parsed.timestamps ?? [])
      .map((t) => ({
        word: String(t.word ?? ""),
        start_time: Number(t.start_time ?? t.start ?? 0),
        end_time: Number(t.end_time ?? t.end ?? 0),
      }))
      .filter((t) => t.word);

    const format =
      parsed.audio_format?.includes("wav")
        ? "wav"
        : parsed.audio_format?.includes("ogg") ||
            parsed.audio_format?.includes("opus")
          ? "opus"
          : "mp3";

    return NextResponse.json({
      audioBase64: parsed.audio,
      format,
      timestamps,
      voice,
      model: TTS_MODEL,
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
