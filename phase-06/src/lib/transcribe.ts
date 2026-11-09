export type TranscribeResult = {
  text: string;
  model: string;
};

export async function transcribeWavBlob(
  blob: Blob,
  filename = "speech.wav",
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("file", blob, filename);

  const res = await fetch("/api/transcribe", {
    method: "POST",
    body: form,
  });

  const data = (await res.json()) as {
    text?: string;
    model?: string;
    error?: string;
    detail?: string;
  };

  if (!res.ok) {
    throw new Error(data.detail || data.error || `Transcription failed (${res.status})`);
  }

  return {
    text: (data.text ?? "").trim(),
    model: data.model ?? "whisper",
  };
}

export async function checkSttHealth(): Promise<{
  ok: boolean;
  model?: string;
  error?: string;
}> {
  try {
    const res = await fetch("/api/transcribe", { cache: "no-store" });
    return (await res.json()) as {
      ok: boolean;
      model?: string;
      error?: string;
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
