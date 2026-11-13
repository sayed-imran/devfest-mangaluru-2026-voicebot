"use client";

import { useSileroVad, type SpeechSegment } from "@/hooks/useSileroVad";
import {
  checkLlmHealth,
  streamChat,
  type ChatMessage,
} from "@/lib/chat";
import { checkSttHealth, transcribeWavBlob } from "@/lib/transcribe";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

type UiMessage = ChatMessage & {
  id: string;
  pending?: boolean;
  interrupted?: boolean;
  error?: string;
  source?: "voice" | "text";
};

type BusyState = "idle" | "transcribing" | "thinking";

function shortModel(name: string) {
  const parts = name.split("/");
  return parts[parts.length - 1] ?? name;
}

function hasMeaningfulSpeech(text: string) {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (cleaned === "(no speech detected)") return false;
  // Require at least one letter/number so noise-only transcripts don't barge in.
  return /[\p{L}\p{N}]/u.test(cleaned);
}

export default function ChatApp() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<BusyState>("idle");
  const [sttReady, setSttReady] = useState<boolean | null>(null);
  const [llmReady, setLlmReady] = useState<boolean | null>(null);
  const [sttModel, setSttModel] = useState("whisper-large-v3-turbo");
  const [llmModel, setLlmModel] = useState("gemma4-26b");
  const [statusHint, setStatusHint] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef<BusyState>("idle");
  const messagesRef = useRef<UiMessage[]>([]);
  const turnSeqRef = useRef(0);
  const sttSeqRef = useRef(0);

  const setBusyState = useCallback((next: BusyState) => {
    busyRef.current = next;
    setBusy(next);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([checkSttHealth(), checkLlmHealth()]).then(
      ([stt, llm]) => {
        if (cancelled) return;
        setSttReady(stt.ok);
        setLlmReady(llm.ok);
        if (stt.model) setSttModel(shortModel(stt.model));
        if (llm.model) setLlmModel(shortModel(llm.model));
        if (!stt.ok || !llm.ok) {
          const parts = [
            !stt.ok ? `STT: ${stt.error ?? "offline"}` : null,
            !llm.ok ? `LLM: ${llm.error ?? "offline"}` : null,
          ].filter(Boolean);
          setStatusHint(parts.join(" · "));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const settleInterruptedAssistants = useCallback(() => {
    setMessages((prev) =>
      prev
        .map((m) => {
          if (m.role !== "assistant" || !m.pending) return m;
          if (!m.content.trim()) return null;
          return { ...m, pending: false, interrupted: true };
        })
        .filter((m): m is UiMessage => m !== null),
    );
  }, []);

  const interruptOngoing = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    settleInterruptedAssistants();
  }, [settleInterruptedAssistants]);

  const runAssistant = useCallback(
    async (history: ChatMessage[], turnId: number) => {
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          pending: true,
        },
      ]);
      setBusyState("thinking");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const full = await streamChat(
          history,
          (chunk) => {
            if (turnSeqRef.current !== turnId) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + chunk, pending: true }
                  : m,
              ),
            );
          },
          controller.signal,
        );

        if (turnSeqRef.current !== turnId) return;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: full || m.content || "(empty reply)",
                  pending: false,
                }
              : m,
          ),
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          setMessages((prev) =>
            prev
              .map((m) => {
                if (m.id !== assistantId) return m;
                if (!m.content.trim()) return null;
                return { ...m, pending: false, interrupted: true };
              })
              .filter((m): m is UiMessage => m !== null),
          );
          return;
        }

        if (turnSeqRef.current !== turnId) return;

        const message = error instanceof Error ? error.message : String(error);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  pending: false,
                  error: message,
                  content: m.content || "Something went wrong.",
                }
              : m,
          ),
        );
        setStatusHint(message);
      } finally {
        if (turnSeqRef.current === turnId) {
          setBusyState("idle");
          abortRef.current = null;
        }
      }
    },
    [setBusyState],
  );

  const sendText = useCallback(
    async (text: string, source: "voice" | "text") => {
      const cleaned = text.trim();
      if (!cleaned) return;

      // New meaningful input always barges in on the current turn.
      interruptOngoing();
      const turnId = ++turnSeqRef.current;

      const userMsg: UiMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: cleaned,
        source,
      };

      const base = messagesRef.current
        .filter((m) => !(m.role === "assistant" && m.pending && !m.content.trim()))
        .map((m) =>
          m.pending ? { ...m, pending: false, interrupted: true } : m,
        );

      const next = [...base, userMsg];
      messagesRef.current = next;
      setMessages(next);
      setDraft("");
      setStatusHint(
        source === "voice" && busyRef.current === "thinking"
          ? "Interrupted — new voice turn"
          : null,
      );

      const history: ChatMessage[] = next
        .filter((m) => !m.error && m.content.trim())
        .map(({ role, content }) => ({ role, content }));

      await runAssistant(history, turnId);
    },
    [interruptOngoing, runAssistant],
  );

  const onSegment = useCallback(
    async (segment: SpeechSegment) => {
      const sttId = ++sttSeqRef.current;
      const priorBusy = busyRef.current;

      // Keep streaming UI as "thinking" while we check whether speech is real.
      if (priorBusy !== "thinking") {
        setBusyState("transcribing");
      }
      setStatusHint(
        priorBusy === "thinking" ? "Checking interrupt…" : "Transcribing…",
      );

      try {
        const result = await transcribeWavBlob(segment.wavBlob);
        if (sttId !== sttSeqRef.current) return;

        const text = result.text.trim();
        if (!hasMeaningfulSpeech(text)) {
          // Noise / empty STT must not interrupt an in-flight reply.
          if (priorBusy === "thinking" && turnSeqRef.current > 0 && abortRef.current) {
            setStatusHint(null);
            setBusyState("thinking");
            return;
          }
          setStatusHint("No speech detected in that clip.");
          if (busyRef.current === "transcribing") setBusyState("idle");
          return;
        }

        setStatusHint(null);
        await sendText(text, "voice");
      } catch (error) {
        if (sttId !== sttSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatusHint(`STT error · ${message}`);
        if (priorBusy === "thinking" && abortRef.current) {
          setBusyState("thinking");
        } else if (busyRef.current === "transcribing") {
          setBusyState("idle");
        }
      }
    },
    [sendText, setBusyState],
  );

  const vad = useSileroVad({ onSegment });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendText(draft, "text");
  };

  const clearChat = () => {
    sttSeqRef.current += 1;
    turnSeqRef.current += 1;
    interruptOngoing();
    setMessages([]);
    messagesRef.current = [];
    setStatusHint(null);
    setBusyState("idle");
  };

  const micLabel = useMemo(() => {
    if (vad.loading) return "Loading mic…";
    if (vad.errored) return "Mic error";
    if (!vad.ready) return "Mic unavailable";
    if (vad.listening && vad.userSpeaking) return "Listening · speaking";
    if (vad.listening) return "Listening";
    return "Voice off";
  }, [vad.loading, vad.errored, vad.ready, vad.listening, vad.userSpeaking]);

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="chat-brand">
          <p className="eyebrow">Phase 03 · Voice in, text out</p>
          <h1>Hey Gemma, No Internet</h1>
        </div>
        <div className="health-row" aria-label="Service health">
          <span
            className={`pill ${sttReady ? "ok" : sttReady === false ? "bad" : ""}`}
          >
            STT {sttReady === null ? "…" : sttReady ? "online" : "offline"}
          </span>
          <span
            className={`pill ${llmReady ? "ok" : llmReady === false ? "bad" : ""}`}
          >
            LLM {llmReady === null ? "…" : llmReady ? "online" : "offline"}
          </span>
          <span className="pill muted">{llmModel}</span>
          <span className="pill muted">{sttModel}</span>
        </div>
      </header>

      <section className="chat-panel" aria-label="Conversation">
        <div className="chat-toolbar">
          <p className={`mic-status ${vad.listening ? "live" : ""}`} role="status">
            {busy === "transcribing"
              ? "Transcribing…"
              : busy === "thinking"
                ? "Thinking… (say or type to interrupt)"
                : micLabel}
          </p>
          {messages.length > 0 && (
            <button type="button" className="btn ghost small" onClick={clearChat}>
              Clear
            </button>
          )}
        </div>

        <div className="message-list" ref={listRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>
                Turn on the mic and ask something. Silero cuts your speech,
                Whisper turns it into text, and Gemma 4 replies in text. You can
                also type, and interrupt anytime with new speech or text.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <article
                key={message.id}
                className={`bubble ${message.role} ${message.error ? "error" : ""}`}
              >
                <div className="bubble-meta">
                  <span>{message.role === "user" ? "You" : "Gemma"}</span>
                  {message.source === "voice" && (
                    <span className="source-tag">voice</span>
                  )}
                  {message.interrupted && (
                    <span className="source-tag interrupted">interrupted</span>
                  )}
                  {message.pending && <span className="source-tag pulse">…</span>}
                </div>
                <p className="bubble-text">
                  {message.content || (message.pending ? "…" : "")}
                </p>
                {message.error && (
                  <p className="bubble-error">{message.error}</p>
                )}
              </article>
            ))
          )}
        </div>

        {statusHint && (
          <p className="status-hint" role="status">
            {statusHint}
          </p>
        )}

        {vad.errored && (
          <p className="error-banner" role="alert">
            {String(vad.errored)}
          </p>
        )}

        <form className="composer" onSubmit={onSubmit}>
          <button
            type="button"
            className={`btn mic ${vad.listening ? "on" : ""} ${vad.userSpeaking ? "speaking" : ""}`}
            onClick={() => void vad.toggle()}
            disabled={vad.loading || Boolean(vad.errored) || !vad.ready}
            aria-pressed={vad.listening}
            title={vad.listening ? "Pause microphone" : "Start voice input"}
          >
            {vad.listening ? "Mic on" : "Mic"}
          </button>

          <input
            className="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              busy === "thinking"
                ? "Interrupt with a new message…"
                : vad.listening
                  ? "Listening… or type instead"
                  : "Message Gemma…"
            }
            autoComplete="off"
            aria-label="Message"
          />

          <button
            type="submit"
            className="btn primary"
            disabled={!draft.trim()}
          >
            {busy === "thinking" ? "Interrupt" : "Send"}
          </button>
        </form>
      </section>
    </div>
  );
}
