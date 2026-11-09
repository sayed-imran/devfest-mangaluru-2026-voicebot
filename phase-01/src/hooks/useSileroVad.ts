"use client";

import { MicVAD, utils } from "@ricky0123/vad-web";
import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechSegment = {
  id: string;
  url: string;
  durationMs: number;
  createdAt: number;
};

const SAMPLE_RATE = 16_000;
const ASSET_PATH = "/vad/";

type VadCallbacks = {
  onSpeechProb?: (prob: number) => void;
  onLog?: (message: string) => void;
  onSegment?: (segment: SpeechSegment) => void;
};

/**
 * Thin MicVAD wrapper that avoids a known @ricky0123/vad-react bug:
 * destroy() throws "MicVAD has null stream..." when start() was never called
 * (common with startOnLoad:false + React Strict Mode remounts).
 */
export function useSileroVad(callbacks: VadCallbacks = {}) {
  const [loading, setLoading] = useState(true);
  const [listening, setListening] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [errored, setErrored] = useState<string | false>(false);
  const [ready, setReady] = useState(false);

  const vadRef = useRef<MicVAD | null>(null);
  const startedRef = useRef(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const safeDestroy = useCallback(async (vad: MicVAD) => {
    try {
      // Only call destroy after audio graph exists; otherwise the library throws.
      if (startedRef.current || vad.listening) {
        await vad.destroy();
      } else {
        // Release the ONNX session without touching the null audio graph.
        const model = (vad as unknown as { model?: { release: () => Promise<void> } })
          .model;
        await model?.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("null stream")) {
        console.warn("VAD cleanup warning:", error);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        setLoading(true);
        setErrored(false);

        const vad = await MicVAD.new({
          model: "v5",
          baseAssetPath: ASSET_PATH,
          onnxWASMBasePath: ASSET_PATH,
          // ScriptProcessor avoids AudioWorklet module loading quirks in some
          // Next.js / hostname setups; still fully client-side Silero VAD.
          processorType: "ScriptProcessor",
          ortConfig: (ort) => {
            ort.env.logLevel = "error";
          },
          onFrameProcessed: (probs) => {
            setUserSpeaking(probs.isSpeech > 0.6);
            callbacksRef.current.onSpeechProb?.(probs.isSpeech);
          },
          onSpeechStart: () => {
            callbacksRef.current.onLog?.("Speech start");
          },
          onSpeechRealStart: () => {
            callbacksRef.current.onLog?.("Confirmed speech");
          },
          onVADMisfire: () => {
            callbacksRef.current.onLog?.("Misfire (too short)");
          },
          onSpeechEnd: (audio) => {
            const wavBuffer = utils.encodeWAV(audio);
            const base64 = utils.arrayBufferToBase64(wavBuffer);
            const durationMs = Math.round((audio.length / SAMPLE_RATE) * 1000);
            callbacksRef.current.onSegment?.({
              id: crypto.randomUUID(),
              url: `data:audio/wav;base64,${base64}`,
              durationMs,
              createdAt: Date.now(),
            });
            callbacksRef.current.onLog?.(
              `Speech end · ${durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`}`,
            );
          },
        });

        if (cancelled) {
          await safeDestroy(vad);
          return;
        }

        vadRef.current = vad;
        setReady(true);
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        setErrored(error instanceof Error ? error.message : String(error));
      }
    };

    void setup();

    return () => {
      cancelled = true;
      const vad = vadRef.current;
      vadRef.current = null;
      setReady(false);
      if (vad) {
        void safeDestroy(vad).finally(() => {
          startedRef.current = false;
        });
      }
    };
  }, [safeDestroy]);

  const start = useCallback(async () => {
    const vad = vadRef.current;
    if (!vad || loading || errored) return;

    try {
      await vad.start();
      startedRef.current = true;

      // Unlock AudioContext after a user gesture if the browser suspended it.
      const ctx = (
        vad as unknown as { _audioContext?: AudioContext }
      )._audioContext;
      if (ctx && ctx.state === "suspended") {
        await ctx.resume();
      }

      setListening(true);
      callbacksRef.current.onLog?.("Listening");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrored(message);
      setListening(false);
    }
  }, [loading, errored]);

  const pause = useCallback(async () => {
    const vad = vadRef.current;
    if (!vad || !listening) return;

    try {
      await vad.pause();
      setListening(false);
      setUserSpeaking(false);
      callbacksRef.current.onLog?.("Paused");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ignore library null-graph errors if pause races cleanup.
      if (!message.includes("null stream")) {
        setErrored(message);
      }
      setListening(false);
    }
  }, [listening]);

  const toggle = useCallback(async () => {
    if (listening) {
      await pause();
    } else {
      await start();
    }
  }, [listening, pause, start]);

  return {
    ready,
    loading,
    listening,
    userSpeaking,
    errored,
    start,
    pause,
    toggle,
  };
}
