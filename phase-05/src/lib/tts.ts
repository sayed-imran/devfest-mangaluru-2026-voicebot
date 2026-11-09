export type WordTimestamp = {
  word: string;
  start_time: number;
  end_time: number;
};

export type CaptionedSpeech = {
  audioUrl: string;
  mimeType: string;
  timestamps: WordTimestamp[];
  voice: string;
};

export type TtsHealth = {
  ok: boolean;
  voice?: string;
  error?: string;
};

export async function checkTtsHealth(): Promise<TtsHealth> {
  try {
    const res = await fetch("/api/tts", { cache: "no-store" });
    return (await res.json()) as TtsHealth;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function synthesizeCaptioned(
  text: string,
  signal?: AbortSignal,
): Promise<CaptionedSpeech> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  const data = (await res.json()) as {
    audioBase64?: string;
    format?: string;
    timestamps?: WordTimestamp[];
    voice?: string;
    error?: string;
    detail?: string;
  };

  if (!res.ok) {
    throw new Error(data.detail || data.error || `TTS failed (${res.status})`);
  }

  if (!data.audioBase64) {
    throw new Error("TTS returned no audio");
  }

  const mimeType =
    data.format === "wav"
      ? "audio/wav"
      : data.format === "opus"
        ? "audio/ogg"
        : data.format === "flac"
          ? "audio/flac"
          : "audio/mpeg";

  const binary = atob(data.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const audioUrl = URL.createObjectURL(blob);

  return {
    audioUrl,
    mimeType,
    timestamps: data.timestamps ?? [],
    voice: data.voice ?? "kokoro",
  };
}
