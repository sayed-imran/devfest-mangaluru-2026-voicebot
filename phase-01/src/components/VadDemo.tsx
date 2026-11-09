"use client";

import { useSileroVad, type SpeechSegment } from "@/hooks/useSileroVad";
import { useCallback, useMemo, useState } from "react";

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function VadDemo() {
  const [segments, setSegments] = useState<SpeechSegment[]>([]);
  const [speechProb, setSpeechProb] = useState(0);
  const [eventLog, setEventLog] = useState<string[]>([]);

  const pushLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setEventLog((prev) => [`${stamp}  ${message}`, ...prev].slice(0, 12));
  }, []);

  const onSegment = useCallback((segment: SpeechSegment) => {
    setSegments((prev) => [segment, ...prev].slice(0, 20));
  }, []);

  const vad = useSileroVad({
    onSpeechProb: setSpeechProb,
    onLog: pushLog,
    onSegment,
  });

  const status = useMemo(() => {
    if (vad.errored) return { label: "Error", tone: "error" as const };
    if (vad.loading) return { label: "Loading model…", tone: "muted" as const };
    if (!vad.listening) return { label: "Idle", tone: "muted" as const };
    if (vad.userSpeaking) return { label: "Speaking", tone: "live" as const };
    return { label: "Listening", tone: "ready" as const };
  }, [vad.errored, vad.loading, vad.listening, vad.userSpeaking]);

  const probabilityPct = Math.round(speechProb * 100);

  return (
    <div className="demo">
      <section className="hero" aria-label="Voice activity detector">
        <p className="eyebrow">Phase 01 · Browser-only</p>
        <h1 className="brand">Hey Gemma, No Internet</h1>
        <p className="lede">
          Silero VAD runs entirely in your browser via ONNX Runtime Web — mic
          frames in, speech segments out. No audio leaves this machine.
        </p>

        <div
          className={`orb ${status.tone} ${vad.userSpeaking ? "pulse" : ""}`}
          aria-hidden
        >
          <span className="orb-ring" />
          <span className="orb-core" />
        </div>

        <p className={`status status-${status.tone}`} role="status">
          {status.label}
        </p>

        <div className="meter" aria-label="Speech probability">
          <div className="meter-track">
            <div
              className="meter-fill"
              style={{ width: `${probabilityPct}%` }}
            />
          </div>
          <span className="meter-label">{probabilityPct}% speech</span>
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void vad.toggle()}
            disabled={vad.loading || Boolean(vad.errored) || !vad.ready}
          >
            {vad.listening ? "Pause mic" : "Start listening"}
          </button>
          {segments.length > 0 && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setSegments([])}
            >
              Clear clips
            </button>
          )}
        </div>

        {vad.errored && (
          <p className="error-banner" role="alert">
            {String(vad.errored)}
          </p>
        )}
      </section>

      <section className="panel pipeline" aria-label="Client pipeline">
        <h2>Client pipeline</h2>
        <ol>
          <li>
            <strong>Microphone</strong> — getUserMedia (mono)
          </li>
          <li>
            <strong>ScriptProcessor</strong> — frame audio in-browser
          </li>
          <li>
            <strong>Silero VAD</strong> — ONNX model in WASM (
            <a
              href="https://github.com/snakers4/silero-vad"
              target="_blank"
              rel="noreferrer"
            >
              snakers4/silero-vad
            </a>
            )
          </li>
          <li>
            <strong>Speech clips</strong> — WAV segments ready for STT later
          </li>
        </ol>
      </section>

      <section className="panel clips" aria-label="Captured speech">
        <div className="panel-head">
          <h2>Captured speech</h2>
          <span className="count">{segments.length}</span>
        </div>

        {segments.length === 0 ? (
          <p className="empty">
            Press start, then speak. Each detected utterance appears here as a
            playable clip.
          </p>
        ) : (
          <ul className="clip-list">
            {segments.map((segment, index) => (
              <li key={segment.id} className="clip">
                <div className="clip-meta">
                  <span>#{segments.length - index}</span>
                  <span>{formatTime(segment.createdAt)}</span>
                  <span>{formatDuration(segment.durationMs)}</span>
                </div>
                <audio controls preload="none" src={segment.url} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel log" aria-label="Event log">
        <h2>Event log</h2>
        {eventLog.length === 0 ? (
          <p className="empty">VAD events will show up here.</p>
        ) : (
          <ul className="log-list">
            {eventLog.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
