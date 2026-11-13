"use client";

import { MicVAD, utils } from "@ricky0123/vad-web";
import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechSegment = {
  id: string;
  url: string;
  wavBlob: Blob;
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

export type VadOptions = {
  /** When true, pause() flushes in-progress speech as a segment (push-to-talk). */
  submitUserSpeechOnPause?: boolean;
};

/**
 * Thin MicVAD wrapper that avoids a known @ricky0123/vad-react bug:
 * destroy() throws "MicVAD has null stream..." when start() was never called
 * (common with startOnLoad:false + React Strict Mode remounts).
 */
export function useSileroVad(
  callbacks: VadCallbacks = {},
  options: VadOptions = {},
) {
  const [loading, setLoading] = useState(true);
  const [listening, setListening] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [errored, setErrored] = useState<string | false>(false);
  const [ready, setReady] = useState(false);

  const vadRef = useRef<MicVAD | null>(null);
  const startedRef = useRef(false);
  const listeningRef = useRef(false);
  const callbacksRef = useRef(callbacks);
  const optionsRef = useRef(options);

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    optionsRef.current = options;
    vadRef.current?.setOptions({
      submitUserSpeechOnPause: Boolean(options.submitUserSpeechOnPause),
    });
  }, [options.submitUserSpeechOnPause]);

  const safeDestroy = useCallback(async (vad: MicVAD) => {
    try {
      if (startedRef.current || vad.listening) {
        await vad.destroy();
      } else {
        const model = (
          vad as unknown as { model?: { release: () => Promise<void> } }
        ).model;
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
          // vad-web defaults to startOnLoad: true, which starts listening (and sending
          // segments) the moment the page loads, regardless of the UI's mic state or
          // voice mode. Only start() may open the mic.
          startOnLoad: false,
          baseAssetPath: ASSET_PATH,
          onnxWASMBasePath: ASSET_PATH,
          processorType: "ScriptProcessor",
          submitUserSpeechOnPause: Boolean(
            optionsRef.current.submitUserSpeechOnPause,
          ),
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
            const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });

            callbacksRef.current.onSegment?.({
              id: crypto.randomUUID(),
              url: `data:audio/wav;base64,${base64}`,
              wavBlob,
              durationMs,
              createdAt: Date.now(),
            });
            callbacksRef.current.onLog?.(
              `Speech end · ${
                durationMs < 1000
                  ? `${durationMs} ms`
                  : `${(durationMs / 1000).toFixed(1)} s`
              }`,
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
    if (!vad || loading || errored || listeningRef.current) return;

    try {
      await vad.start();
      startedRef.current = true;

      const ctx = (vad as unknown as { _audioContext?: AudioContext })
        ._audioContext;
      if (ctx && ctx.state === "suspended") {
        await ctx.resume();
      }

      listeningRef.current = true;
      setListening(true);
      callbacksRef.current.onLog?.("Listening");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrored(message);
      listeningRef.current = false;
      setListening(false);
    }
  }, [loading, errored]);

  const pause = useCallback(async () => {
    const vad = vadRef.current;
    if (!vad || !listeningRef.current) return;

    try {
      await vad.pause();
      listeningRef.current = false;
      setListening(false);
      setUserSpeaking(false);
      callbacksRef.current.onLog?.("Paused");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("null stream")) {
        setErrored(message);
      }
      listeningRef.current = false;
      setListening(false);
    }
  }, []);

  const toggle = useCallback(async () => {
    if (listeningRef.current) {
      await pause();
    } else {
      await start();
    }
  }, [pause, start]);

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
