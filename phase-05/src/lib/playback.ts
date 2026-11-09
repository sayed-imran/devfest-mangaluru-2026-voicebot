import type { WordTimestamp } from "@/lib/tts";

export type PlaybackHandlers = {
  onReveal: (spokenText: string) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
};

/**
 * How far the on-screen text should trail the audio clock.
 * Browsers often report currentTime / fire `playing` before sound is audible,
 * and Kokoro start times can sit slightly ahead of perceived speech.
 */
const REVEAL_LAG_SEC = Number(
  process.env.NEXT_PUBLIC_TTS_REVEAL_LAG_MS ?? 140,
) / 1000;

function formatSpoken(timestamps: WordTimestamp[], endIndex: number) {
  return timestamps
    .slice(0, endIndex + 1)
    .map((t) => t.word)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1");
}

/**
 * Play captioned TTS audio and reveal text in lockstep with word timestamps.
 * Returns a stop() function that aborts playback and cleans up the object URL.
 */
export function playCaptionedSpeech(
  audioUrl: string,
  timestamps: WordTimestamp[],
  handlers: PlaybackHandlers,
): () => void {
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = audioUrl;

  let stopped = false;
  let frame = 0;
  let lastIndex = -1;
  let ticking = false;

  const revealUpTo = (mediaTimeSec: number) => {
    if (!timestamps.length) return;

    // Trail the media clock so words don't flash before you hear them.
    const effectiveTime = mediaTimeSec - Math.max(0, REVEAL_LAG_SEC);

    let index = -1;
    for (let i = 0; i < timestamps.length; i += 1) {
      if (timestamps[i].start_time <= effectiveTime) {
        index = i;
      } else {
        break;
      }
    }

    if (index === lastIndex) return;
    lastIndex = index;

    if (index < 0) {
      handlers.onReveal("");
      return;
    }

    handlers.onReveal(formatSpoken(timestamps, index));
  };

  const tick = () => {
    if (stopped) return;
    revealUpTo(audio.currentTime);
    frame = requestAnimationFrame(tick);
  };

  const startTicking = () => {
    if (stopped || ticking) return;
    ticking = true;
    // Keep the bubble empty until the lagged clock reaches the first word.
    handlers.onReveal("");
    frame = requestAnimationFrame(tick);
  };

  const cleanup = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(audioUrl);
  };

  audio.onplaying = () => {
    startTicking();
  };

  audio.onended = () => {
    if (stopped) return;
    if (timestamps.length) {
      handlers.onReveal(formatSpoken(timestamps, timestamps.length - 1));
    }
    cleanup();
    handlers.onDone?.();
  };

  audio.onerror = () => {
    if (stopped) return;
    cleanup();
    handlers.onError?.(new Error("Audio playback failed"));
  };

  void audio.play().then(
    () => {
      if (stopped) return;
      // Fallback if `playing` already fired or never does (some browsers).
      if (!timestamps.length) {
        handlers.onReveal("");
        return;
      }
      if (audio.currentTime > 0 || !audio.paused) {
        startTicking();
      }
    },
    (error: unknown) => {
      if (stopped) return;
      cleanup();
      handlers.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    },
  );

  return cleanup;
}
