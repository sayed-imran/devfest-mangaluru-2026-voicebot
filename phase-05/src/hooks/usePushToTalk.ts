"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeechSegment } from "@/hooks/useSileroVad";

/**
 * Push-to-talk recorder: no voice activity detection at all.
 *
 * Everything heard between start() and stop() becomes one WAV clip, silences and all.
 * Silero VAD is not involved, so it cannot cut a held sentence at a pause or drop a quiet
 * word. The mic stream stays open while push-to-talk mode is enabled so the first syllable
 * is not lost to getUserMedia start-up, but audio is only kept while the key is held.
 */

/** Holds shorter than this are treated as accidental taps. */
const MIN_CLIP_MS = 250;
/** Audio kept from just before the key went down, so the first syllable survives. */
const PRE_ROLL_MS = 150;

export function usePushToTalk({ enabled }: { enabled: boolean }) {
  const [recording, setRecording] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const recordingRef = useRef(false);
  const chunksRef = useRef<Float32Array[]>([]);
  const preRollRef = useRef<Float32Array[]>([]);
  const openingRef = useRef<Promise<void> | null>(null);

  /** Close the mic and audio graph. No state updates, so it is safe in effects. */
  const release = useCallback(() => {
    recordingRef.current = false;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    chunksRef.current = [];
    preRollRef.current = [];
    openingRef.current = null;
  }, []);

  const open = useCallback(async () => {
    if (ctxRef.current) return;
    if (openingRef.current) return openingRef.current;

    openingRef.current = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const preRollChunks = Math.max(
        1,
        Math.ceil((PRE_ROLL_MS / 1000) * ctx.sampleRate / 2048),
      );

      node.onaudioprocess = (event) => {
        const frame = new Float32Array(event.inputBuffer.getChannelData(0));
        if (recordingRef.current) {
          chunksRef.current.push(frame);
        } else {
          const pre = preRollRef.current;
          pre.push(frame);
          if (pre.length > preRollChunks) pre.shift();
        }
      };
      source.connect(node);
      // ScriptProcessor only runs when connected to an output; it writes silence there.
      node.connect(ctx.destination);

      streamRef.current = stream;
      ctxRef.current = ctx;
      nodeRef.current = node;
    })();

    try {
      await openingRef.current;
    } catch (err) {
      // Let the caller (a key / button press) report it; retry on the next press.
      openingRef.current = null;
      throw err;
    }
  }, []);

  // Mic is held open only while push-to-talk mode is on.
  useEffect(() => {
    if (!enabled) {
      release();
      return;
    }
    void open().catch(() => {});
    return release;
  }, [enabled, open, release]);

  const start = useCallback(async () => {
    await open();
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();
    chunksRef.current = [...preRollRef.current];
    recordingRef.current = true;
    setRecording(true);
  }, [open]);

  /** Stops recording and returns the clip, or null for an accidental tap. */
  const stop = useCallback((): SpeechSegment | null => {
    const ctx = ctxRef.current;
    const wasRecording = recordingRef.current;
    recordingRef.current = false;
    setRecording(false);
    if (!wasRecording || !ctx) return null;

    const chunks = chunksRef.current;
    chunksRef.current = [];
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const durationMs = Math.round((length / ctx.sampleRate) * 1000);
    if (durationMs < MIN_CLIP_MS + PRE_ROLL_MS) return null;

    const samples = new Float32Array(length);
    let offset = 0;
    for (const c of chunks) {
      samples.set(c, offset);
      offset += c.length;
    }
    const wavBlob = encodeWav16(samples, ctx.sampleRate);
    return {
      id: crypto.randomUUID(),
      url: "",
      wavBlob,
      durationMs,
      createdAt: Date.now(),
    };
  }, []);

  return { recording, start, stop };
}

/** Mono 16-bit PCM WAV at the capture rate; Whisper resamples server-side. */
function encodeWav16(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
