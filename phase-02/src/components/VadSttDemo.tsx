"use client";

import { useSileroVad, type SpeechSegment } from "@/hooks/useSileroVad";
import { checkSttHealth, transcribeWavBlob } from "@/lib/transcribe";
import { useCallback, useEffect, useMemo, useState } from "react";

type TranscriptStatus = "pending" | "done" | "error";

type Utterance = SpeechSegment & {
  text: string;
  status: TranscriptStatus;
  error?: string;
};

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

export default function VadSttDemo() {
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [speechProb, setSpeechProb] = useState(0);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [sttReady, setSttReady] = useState<boolean | null>(null);
  const [sttModel, setSttModel] = useState("whisper-large-v3-turbo");

  const pushLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setEventLog((prev) => [`${stamp}  ${message}`, ...prev].slice(0, 14));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkSttHealth().then((health) => {
      if (cancelled) return;
      setSttReady(health.ok);
      if (health.model) setSttModel(health.model);
      if (!health.ok) {
        pushLog(`STT offline · ${health.error ?? "unreachable"}`);
      } else {
        pushLog(`STT ready · ${health.model}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pushLog]);

  const transcribeSegment = useCallback(
    async (segment: SpeechSegment) => {
      setUtterances((prev) =>
        prev.map((u) =>
          u.id === segment.id ? { ...u, status: "pending", error: undefined } : u,
        ),
      );

      try {
        const result = await transcribeWavBlob(segment.wavBlob);
        const text = result.text || "(no speech detected)";
        setUtterances((prev) =>
          prev.map((u) =>
            u.id === segment.id
              ? { ...u, text, status: "done", error: undefined }
              : u,
          ),
        );
        pushLog(`Transcript · ${text.slice(0, 48)}${text.length > 48 ? "…" : ""}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setUtterances((prev) =>
          prev.map((u) =>
            u.id === segment.id
              ? { ...u, status: "error", error: message, text: "" }
              : u,
          ),
        );
        pushLog(`STT error · ${message}`);
      }
    },
    [pushLog],
  );

  const onSegment = useCallback(
    (segment: SpeechSegment) => {
      setUtterances((prev) =>
        [
          {
            ...segment,
            text: "",
            status: "pending" as const,
          },
          ...prev,
        ].slice(0, 24),
      );
      void transcribeSegment(segment);
    },
    [transcribeSegment],
  );

  const vad = useSileroVad({
    onSpeechProb: setSpeechProb,
    onLog: pushLog,
    onSegment,
  });

  const status = useMemo(() => {
    if (vad.errored) return { label: "Error", tone: "error" as const };
    if (vad.loading) return { label: "Loading VAD…", tone: "muted" as const };
    if (!vad.listening) return { label: "Idle", tone: "muted" as const };
    if (vad.userSpeaking) return { label: "Speaking", tone: "live" as const };
    return { label: "Listening", tone: "ready" as const };
  }, [vad.errored, vad.loading, vad.listening, vad.userSpeaking]);

  const liveTranscript = useMemo(() => {
    return utterances
      .filter((u) => u.status === "done" && u.text && u.text !== "(no speech detected)")
      .slice()
      .reverse()
      .map((u) => u.text)
      .join(" ");
  }, [utterances]);

  const pendingCount = utterances.filter((u) => u.status === "pending").length;
  const probabilityPct = Math.round(speechProb * 100);

  return (
    <div className="demo">
      <section className="hero" aria-label="Voice activity + speech to text">
        <p className="eyebrow">Phase 02 · VAD + speech to text</p>
        <h1 className="brand">Hey Gemma, No Internet</h1>
        <p className="lede">
          Silero cuts your speech into utterances in the browser, then each clip
          goes to Whisper on the DGX Spark in the room. No audio leaves the local
          network.
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
          {pendingCount > 0 ? ` · transcribing ${pendingCount}` : ""}
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
          {utterances.length > 0 && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setUtterances([])}
            >
              Clear
            </button>
          )}
        </div>

        <div className="health-row" aria-label="Service health">
          <span className={`pill ${sttReady ? "ok" : sttReady === false ? "bad" : ""}`}>
            STT {sttReady === null ? "…" : sttReady ? "online" : "offline"}
          </span>
          <span className="pill muted">{sttModel}</span>
        </div>

        {vad.errored && (
          <p className="error-banner" role="alert">
            {String(vad.errored)}
          </p>
        )}
      </section>

      <section className="panel transcript-live" aria-label="Live transcript">
        <div className="panel-head">
          <h2>Live transcript</h2>
          {pendingCount > 0 && <span className="count pulse-soft">…</span>}
        </div>
        {liveTranscript ? (
          <p className="transcript-text">{liveTranscript}</p>
        ) : (
          <p className="empty">
            Start listening and speak. Transcribed text streams in here after
            each utterance.
          </p>
        )}
      </section>

      <section className="panel pipeline" aria-label="Client pipeline">
        <h2>Pipeline</h2>
        <ol>
          <li>
            <strong>Mic + Silero VAD</strong> — browser-side speech segments
          </li>
          <li>
            <strong>Speech to text</strong> —{" "}
            <code>whisper-large-v3-turbo</code> via vLLM on the Spark (:8001)
          </li>
          <li>
            <strong>Transcript</strong> — text ready for the LLM phase next
          </li>
        </ol>
      </section>

      <section className="panel clips" aria-label="Utterances">
        <div className="panel-head">
          <h2>Utterances</h2>
          <span className="count">{utterances.length}</span>
        </div>

        {utterances.length === 0 ? (
          <p className="empty">
            Each VAD-detected clip appears here with its Whisper transcript.
          </p>
        ) : (
          <ul className="clip-list">
            {utterances.map((utterance, index) => (
              <li key={utterance.id} className="clip">
                <div className="clip-meta">
                  <span>#{utterances.length - index}</span>
                  <span>{formatTime(utterance.createdAt)}</span>
                  <span>{formatDuration(utterance.durationMs)}</span>
                  <span className={`badge ${utterance.status}`}>
                    {utterance.status === "pending"
                      ? "transcribing"
                      : utterance.status}
                  </span>
                </div>
                <p
                  className={`utterance-text ${
                    utterance.status === "pending" ? "pending" : ""
                  } ${utterance.status === "error" ? "error" : ""}`}
                >
                  {utterance.status === "pending"
                    ? "Transcribing…"
                    : utterance.status === "error"
                      ? utterance.error || "Transcription failed"
                      : utterance.text}
                </p>
                <audio controls preload="none" src={utterance.url} />
                {utterance.status === "error" && (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => void transcribeSegment(utterance)}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel log" aria-label="Event log">
        <h2>Event log</h2>
        {eventLog.length === 0 ? (
          <p className="empty">VAD / STT events will show up here.</p>
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
