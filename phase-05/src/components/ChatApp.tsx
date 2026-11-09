"use client";

import MarkdownContent from "@/components/MarkdownContent";
import { useSileroVad, type SpeechSegment } from "@/hooks/useSileroVad";
import {
  checkToolsHealth,
  runAgent,
  summarizeArguments,
  type AgentEvent,
  type ToolActivity,
} from "@/lib/agent";
import {
  checkLlmHealth,
  streamChat,
  type ChatMessage,
} from "@/lib/chat";
import { applySpeakDecision, pickHandoffLine } from "@/lib/partition";
import { requestDeliveryIntent } from "@/lib/partitionClient";
import { playCaptionedSpeech } from "@/lib/playback";
import { isHardStopCommand, looksLikeEcho } from "@/lib/stopCommand";
import { checkSttHealth, transcribeWavBlob } from "@/lib/transcribe";
import { checkTtsHealth, synthesizeCaptioned } from "@/lib/tts";
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
  speaking?: boolean;
  displayContent?: string;
  error?: string;
  source?: "voice" | "text";
  actions?: ToolActivity[];
};

type ToolsInfo = {
  os?: string;
  count?: number;
  dryRun?: boolean;
};

type BusyState = "idle" | "transcribing" | "thinking" | "speaking";

/** Auto VAD, or device-native push-to-talk (mic hold on phone, Space on desktop). */
type VoiceMode = "auto" | "push";

const VOICE_MODE_KEY = "gemma-voice-mode";

function shortModel(name: string) {
  const parts = name.split("/");
  return parts[parts.length - 1] ?? name;
}

function hasMeaningfulSpeech(text: string) {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (cleaned === "(no speech detected)") return false;
  return /[\p{L}\p{N}]/u.test(cleaned);
}

/** Phones/tablets: coarse pointer or mobile UA. Desktops get Space PTT. */
function detectPhoneDevice() {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;
  const ua = navigator.userAgent;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return (coarse && noHover) || mobileUa;
}

function readStoredVoiceMode(): VoiceMode {
  if (typeof window === "undefined") return "auto";
  const saved = window.localStorage.getItem(VOICE_MODE_KEY);
  // Migrate older per-control mode ids.
  if (saved === "push" || saved === "hold-mic" || saved === "hold-space") {
    return "push";
  }
  return "auto";
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export default function ChatApp() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<BusyState>("idle");
  const [sttReady, setSttReady] = useState<boolean | null>(null);
  const [llmReady, setLlmReady] = useState<boolean | null>(null);
  const [ttsReady, setTtsReady] = useState<boolean | null>(null);
  const [toolsReady, setToolsReady] = useState<boolean | null>(null);
  const [toolsInfo, setToolsInfo] = useState<ToolsInfo>({});
  const [sttModel, setSttModel] = useState("whisper-large-v3-turbo");
  const [llmModel, setLlmModel] = useState("gemma4-e4b");
  const [ttsVoice, setTtsVoice] = useState("am_michael");
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("auto");
  const [isPhone, setIsPhone] = useState(false);
  const [holding, setHolding] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopSpeechRef = useRef<(() => void) | null>(null);
  const busyRef = useRef<BusyState>("idle");
  const messagesRef = useRef<UiMessage[]>([]);
  const turnSeqRef = useRef(0);
  const sttSeqRef = useRef(0);
  const vadPauseRef = useRef<(() => Promise<void>) | null>(null);
  const vadStartRef = useRef<(() => Promise<void>) | null>(null);
  const listeningRef = useRef(false);
  const wasListeningRef = useRef(false);
  const holdPressedRef = useRef(false);
  const voiceModeRef = useRef<VoiceMode>("auto");
  const lastSpokenRef = useRef("");

  const setBusyState = useCallback((next: BusyState) => {
    busyRef.current = next;
    setBusy(next);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const syncDevice = () => setIsPhone(detectPhoneDevice());
    syncDevice();
    setVoiceMode(readStoredVoiceMode());

    const coarse = window.matchMedia("(pointer: coarse)");
    const hover = window.matchMedia("(hover: none)");
    coarse.addEventListener("change", syncDevice);
    hover.addEventListener("change", syncDevice);
    return () => {
      coarse.removeEventListener("change", syncDevice);
      hover.removeEventListener("change", syncDevice);
    };
  }, []);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
    try {
      window.localStorage.setItem(VOICE_MODE_KEY, voiceMode);
    } catch {
      // ignore quota / private mode
    }
  }, [voiceMode]);

  const pushLabel = isPhone ? "Hold mic" : "Space";
  const pushHint = isPhone
    ? "Press and hold the mic to talk"
    : "Hold Space to talk";
  const voiceModes = useMemo(
    () => [
      { id: "auto" as const, label: "Auto", hint: "Always listening — speak freely" },
      { id: "push" as const, label: pushLabel, hint: pushHint },
    ],
    [pushLabel, pushHint],
  );
  const isPushToTalk = voiceMode === "push";
  const useMicHold = isPushToTalk && isPhone;
  const useSpaceHold = isPushToTalk && !isPhone;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      checkSttHealth(),
      checkLlmHealth(),
      checkTtsHealth(),
      checkToolsHealth(),
    ]).then(([stt, llm, tts, tools]) => {
      if (cancelled) return;
      setSttReady(stt.ok);
      setLlmReady(llm.ok);
      setTtsReady(tts.ok);
      setToolsReady(tools.ok);
      setToolsInfo({ os: tools.os, count: tools.tools, dryRun: tools.dry_run });
      if (stt.model) setSttModel(shortModel(stt.model));
      if (llm.model) setLlmModel(shortModel(llm.model));
      if (tts.voice) setTtsVoice(tts.voice);
      const desktopBlocked = tools.ok && tools.desktop && !tools.desktop.can_open;
      if (!stt.ok || !llm.ok || !tts.ok || !tools.ok || desktopBlocked) {
        const parts = [
          !stt.ok ? `STT: ${stt.error ?? "offline"}` : null,
          !llm.ok ? `LLM: ${llm.error ?? "offline"}` : null,
          !tts.ok ? `TTS: ${tts.error ?? "offline"}` : null,
          !tools.ok
            ? `Tools: ${tools.error ?? "offline"} (chat still works)`
            : null,
          desktopBlocked ? `Tools: ${tools.desktop?.detail}` : null,
        ].filter(Boolean);
        setStatusHint(parts.join(" · "));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    return () => {
      stopSpeechRef.current?.();
    };
  }, []);

  const settleInterruptedAssistants = useCallback(() => {
    setMessages((prev) =>
      prev
        .map((m) => {
          if (m.role !== "assistant" || (!m.pending && !m.speaking)) return m;
          const content = m.content.trim();
          if (!content && !m.displayContent?.trim() && !m.actions?.length) {
            return null;
          }
          return {
            ...m,
            pending: false,
            speaking: false,
            interrupted: true,
          };
        })
        .filter((m): m is UiMessage => m !== null),
    );
  }, []);

  const stopSpeech = useCallback(() => {
    stopSpeechRef.current?.();
    stopSpeechRef.current = null;
  }, []);

  const interruptOngoing = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeech();
    settleInterruptedAssistants();
  }, [settleInterruptedAssistants, stopSpeech]);

  const pauseMicForSpeech = useCallback(async () => {
    // Keep the mic open so the user can barge in / say "stop" while Gemma talks.
    // Echo is filtered in onSegment via looksLikeEcho(lastSpokenRef).
    wasListeningRef.current = listeningRef.current;
  }, []);

  const resumeMicAfterSpeech = useCallback(async () => {
    // No-op when we no longer pause for TTS; keep listening continuous.
    if (!wasListeningRef.current) return;
    if (listeningRef.current) return;
    try {
      await vadStartRef.current?.();
    } catch {
      // ignore
    }
  }, []);

  /** Speak `speakText` with Kokoro; reveal into the assistant bubble. */
  const playSpeakText = useCallback(
    async (assistantId: string, speakText: string, turnId: number) => {
      const speak = speakText.trim();
      if (!speak) return;

      lastSpokenRef.current = speak;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "", pending: false, speaking: true }
            : m,
        ),
      );
      setBusyState("speaking");

      const captioned = await synthesizeCaptioned(
        speak,
        abortRef.current?.signal,
      );
      if (turnSeqRef.current !== turnId) {
        URL.revokeObjectURL(captioned.audioUrl);
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const stop = playCaptionedSpeech(
          captioned.audioUrl,
          captioned.timestamps,
          {
            onReveal: (spokenText) => {
              if (turnSeqRef.current !== turnId) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content:
                          spokenText ||
                          (captioned.timestamps.length ? m.content : speak),
                        speaking: true,
                      }
                    : m,
                ),
              );
            },
            onDone: () => {
              stopSpeechRef.current = null;
              resolve();
            },
            onError: (error) => {
              stopSpeechRef.current = null;
              reject(error);
            },
          },
        );
        stopSpeechRef.current = () => {
          stop();
          reject(new DOMException("Aborted", "AbortError"));
        };
      });

      if (turnSeqRef.current !== turnId) return;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: speak, speaking: false, pending: false }
            : m,
        ),
      );
    },
    [setBusyState],
  );

  /** Mirror tool activity from the agent stream into the assistant bubble. */
  const applyAgentEvent = useCallback(
    (assistantId: string, event: AgentEvent) => {
      if (event.type === "tool_call") {
        setStatusHint(`${event.title}…`);
        const activity: ToolActivity = {
          id: event.id,
          name: event.name,
          title: event.title,
          status: "running",
          detail: summarizeArguments(event.arguments),
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, actions: [...(m.actions ?? []), activity] }
              : m,
          ),
        );
        return;
      }
      if (event.type === "tool_result") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  actions: (m.actions ?? []).map((a) =>
                    a.id === event.id
                      ? {
                          ...a,
                          status: event.ok ? "ok" : "error",
                          message: event.message,
                          url: event.url,
                          dryRun: event.dry_run,
                        }
                      : a,
                  ),
                }
              : m,
          ),
        );
      }
    },
    [],
  );

  const runAssistant = useCallback(
    async (history: ChatMessage[], turnId: number, userText: string) => {
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
      setStatusHint("Deciding how to answer…");

      const controller = new AbortController();
      abortRef.current = controller;

      let full = "";
      try {
        // 1) Laya on the user utterance — action vs chat, then speak vs handoff.
        const lastAssistant =
          [...history].reverse().find((m) => m.role === "assistant")
            ?.content ?? "";
        const intent = await requestDeliveryIntent(userText, {
          signal: controller.signal,
          lastAssistant,
        });
        if (turnSeqRef.current !== turnId) return;

        const action = intent.route === "action";
        const handoff = !action && intent.mode === "handoff";
        setStatusHint(
          action
            ? intent.decidedBy === "laya"
              ? "Laya → action — working on it…"
              : "Action — working on it…"
            : handoff
              ? intent.decidedBy === "laya"
                ? "Laya → chat handoff — writing answer…"
                : "Chat handoff — writing answer…"
              : intent.decidedBy === "laya"
                ? "Laya → will speak full reply"
                : null,
        );

        if (handoff) {
          // 2a) Speak a short cue immediately while the essay streams into chat.
          await pauseMicForSpeech();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: "",
                    displayContent: "",
                    pending: true,
                    speaking: true,
                  }
                : m,
            ),
          );

          const speechTask = playSpeakText(
            assistantId,
            intent.speak || pickHandoffLine(),
            turnId,
          ).catch((error: unknown) => {
            if (error instanceof Error && error.name === "AbortError") return;
            const message =
              error instanceof Error ? error.message : String(error);
            setStatusHint(`TTS unavailable · ${message}`);
          });

          await streamChat(
            history,
            (chunk) => {
              if (turnSeqRef.current !== turnId) return;
              full += chunk;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        displayContent: full,
                        pending: true,
                      }
                    : m,
                ),
              );
            },
            controller.signal,
            "handoff",
          );

          if (turnSeqRef.current !== turnId) return;

          await speechTask;
          if (turnSeqRef.current !== turnId) return;

          const cleaned = full.trim() || "(empty reply)";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: m.content || intent.speak || pickHandoffLine(),
                    displayContent: cleaned,
                    pending: false,
                    speaking: false,
                  }
                : m,
            ),
          );
          setStatusHint(null);
          await resumeMicAfterSpeech();
          return;
        }

        // 2b) Speak-all: buffer a short reply (tools agent or LLM), then speak it
        // (with length safety net).
        let answered = false;
        if (action) {
          const done: string[] = [];
          try {
            full = await runAgent(
              history,
              (event) => {
                if (turnSeqRef.current !== turnId) return;
                if (event.type === "tool_result" && event.ok) {
                  done.push(event.message);
                }
                applyAgentEvent(assistantId, event);
              },
              controller.signal,
            );
            answered = true;
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              throw error;
            }
            if (turnSeqRef.current !== turnId) return;
            // A tool already ran: say what it did rather than a tool-less chat reply.
            if (done.length) {
              full = done.join(" ");
              answered = true;
            } else {
              const message =
                error instanceof Error ? error.message : String(error);
              setStatusHint(`Tools unavailable · ${message} — answering in chat`);
            }
          }
        }

        if (!answered) {
          await streamChat(
            history,
            (chunk) => {
              if (turnSeqRef.current !== turnId) return;
              full += chunk;
            },
            controller.signal,
            "speak-all",
          );
        }

        if (turnSeqRef.current !== turnId) return;

        const cleaned = full.trim() || "(empty reply)";
        const partitioned = applySpeakDecision(cleaned, true);

        await pauseMicForSpeech();
        try {
          if (partitioned.mode === "handoff") {
            // Model still wrote something too long — don't read it all aloud.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      displayContent: partitioned.display,
                      pending: false,
                    }
                  : m,
              ),
            );
            setStatusHint("Reply got long — handoff to chat");
            await playSpeakText(assistantId, partitioned.speak, turnId);
          } else {
            await playSpeakText(assistantId, partitioned.speak || cleaned, turnId);
          }
          if (turnSeqRef.current === turnId) setStatusHint(null);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
          const message =
            error instanceof Error ? error.message : String(error);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: cleaned,
                    displayContent: undefined,
                    speaking: false,
                    pending: false,
                  }
                : m,
            ),
          );
          setStatusHint(`TTS unavailable · showed text only (${message})`);
        } finally {
          await resumeMicAfterSpeech();
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          const partial = full.trim();
          setMessages((prev) =>
            prev
              .map((m) => {
                if (m.id !== assistantId) return m;
                if (
                  !partial &&
                  !m.content.trim() &&
                  !m.displayContent?.trim() &&
                  !m.actions?.length
                ) {
                  return null;
                }
                return {
                  ...m,
                  content: m.content.trim() || partial,
                  pending: false,
                  speaking: false,
                  interrupted: true,
                };
              })
              .filter((m): m is UiMessage => m !== null),
          );
          await resumeMicAfterSpeech();
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
                  speaking: false,
                  error: message,
                  content: m.content || "Something went wrong.",
                }
              : m,
          ),
        );
        setStatusHint(message);
        await resumeMicAfterSpeech();
      } finally {
        if (turnSeqRef.current === turnId) {
          setBusyState("idle");
          abortRef.current = null;
          stopSpeechRef.current = null;
        }
      }
    },
    [
      setBusyState,
      playSpeakText,
      pauseMicForSpeech,
      resumeMicAfterSpeech,
      applyAgentEvent,
    ],
  );

  const sendText = useCallback(
    async (text: string, source: "voice" | "text") => {
      const cleaned = text.trim();
      if (!cleaned) return;

      const stopping = isHardStopCommand(cleaned);
      const wasActive =
        busyRef.current === "thinking" ||
        busyRef.current === "speaking" ||
        busyRef.current === "transcribing";

      interruptOngoing();
      const turnId = ++turnSeqRef.current;
      setBusyState("idle");

      const userMsg: UiMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: cleaned,
        source,
      };

      const base = messagesRef.current
        .filter(
          (m) =>
            !(
              m.role === "assistant" &&
              (m.pending || m.speaking) &&
              !m.content.trim() &&
              !m.displayContent?.trim() &&
              !m.actions?.length
            ),
        )
        .map((m) =>
          m.pending || m.speaking
            ? { ...m, pending: false, speaking: false, interrupted: true }
            : m,
        );

      const next = [...base, userMsg];
      messagesRef.current = next;
      setMessages(next);
      setDraft("");

      // Hard stop: abort immediately, never ask the LLM to "acknowledge silence".
      if (stopping) {
        lastSpokenRef.current = "";
        setStatusHint(wasActive ? "Stopped." : "Okay — stopped.");
        await resumeMicAfterSpeech();
        return;
      }

      setStatusHint(
        source === "voice" && wasActive
          ? "Interrupted — new voice turn"
          : null,
      );

      // Full session history → LLM (browser memory only; Clear / refresh resets it).
      const history: ChatMessage[] = next
        .filter((m) => !m.error)
        .map((m) => {
          if (m.role === "assistant") {
            // Prefer the full chat answer; skip noisy spoken-only handoff stubs.
            // Interrupted action turns fall back to what their tools reported.
            const body =
              (m.displayContent || m.content || "").trim() ||
              (m.actions ?? [])
                .filter((a) => a.status === "ok" && a.message)
                .map((a) => a.message)
                .join(" ");
            if (!body) return null;
            // Interrupted mid-handoff with only a spoken cue and no real answer.
            if (
              m.interrupted &&
              !m.displayContent?.trim() &&
              /^(i('ll| will) put |i('m| am) writing |you('ll| will) see )/i.test(
                body,
              )
            ) {
              return {
                role: "assistant" as const,
                content: "[Reply interrupted before the full answer was ready.]",
              };
            }
            return { role: "assistant" as const, content: body };
          }
          const body = m.content.trim();
          if (!body) return null;
          return { role: m.role, content: body };
        })
        .filter((m): m is ChatMessage => m !== null);

      await runAssistant(history, turnId, cleaned);
    },
    [interruptOngoing, resumeMicAfterSpeech, runAssistant, setBusyState],
  );

  const onSegment = useCallback(
    async (segment: SpeechSegment) => {
      const sttId = ++sttSeqRef.current;
      const priorBusy = busyRef.current;

      if (priorBusy !== "thinking" && priorBusy !== "speaking") {
        setBusyState("transcribing");
      }
      setStatusHint(
        priorBusy === "thinking" || priorBusy === "speaking"
          ? "Checking interrupt…"
          : "Transcribing…",
      );

      try {
        const result = await transcribeWavBlob(segment.wavBlob);
        if (sttId !== sttSeqRef.current) return;

        const text = result.text.trim();
        if (!hasMeaningfulSpeech(text)) {
          if (
            (priorBusy === "thinking" || priorBusy === "speaking") &&
            turnSeqRef.current > 0
          ) {
            setStatusHint(null);
            setBusyState(priorBusy);
            return;
          }
          setStatusHint("No speech detected in that clip.");
          if (busyRef.current === "transcribing") setBusyState("idle");
          return;
        }

        // Ignore speaker echo of Gemma unless it's a hard stop command.
        if (
          priorBusy === "speaking" &&
          !isHardStopCommand(text) &&
          looksLikeEcho(text, lastSpokenRef.current)
        ) {
          setStatusHint(null);
          setBusyState("speaking");
          return;
        }

        setStatusHint(null);
        await sendText(text, "voice");
      } catch (error) {
        if (sttId !== sttSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatusHint(`STT error · ${message}`);
        if (
          (priorBusy === "thinking" || priorBusy === "speaking") &&
          turnSeqRef.current > 0
        ) {
          setBusyState(priorBusy);
        } else if (busyRef.current === "transcribing") {
          setBusyState("idle");
        }
      }
    },
    [sendText, setBusyState],
  );

  const vad = useSileroVad(
    { onSegment },
    { submitUserSpeechOnPause: isPushToTalk },
  );

  useEffect(() => {
    vadPauseRef.current = vad.pause;
    vadStartRef.current = vad.start;
    listeningRef.current = vad.listening;
  }, [vad.pause, vad.start, vad.listening]);

  const beginHold = useCallback(async () => {
    if (!vad.ready || vad.loading || vad.errored) return;
    holdPressedRef.current = true;
    setHolding(true);
    await vad.start();
    // Released before mic finished starting — stop and flush nothing useful.
    if (!holdPressedRef.current) {
      await vad.pause();
      setHolding(false);
    }
  }, [vad.ready, vad.loading, vad.errored, vad.start, vad.pause]);

  const endHold = useCallback(async () => {
    if (!holdPressedRef.current && !vad.listening) {
      setHolding(false);
      return;
    }
    holdPressedRef.current = false;
    setHolding(false);
    await vad.pause();
  }, [vad.listening, vad.pause]);

  const changeVoiceMode = useCallback(
    (next: VoiceMode) => {
      if (next === voiceModeRef.current) return;
      holdPressedRef.current = false;
      setHolding(false);
      void vad.pause();
      setVoiceMode(next);
      const hint =
        next === "auto"
          ? "Always listening — speak freely"
          : pushHint;
      setStatusHint(hint);
    },
    [vad.pause, pushHint],
  );

  // Desktop Space push-to-talk (ignored while typing in the composer).
  useEffect(() => {
    if (!useSpaceHold) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (isEditableTarget(event.target)) return;
      if (event.repeat) return;
      event.preventDefault();
      void beginHold();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void endHold();
    };

    const onBlur = () => {
      void endHold();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      void endHold();
    };
  }, [useSpaceHold, beginHold, endHold]);

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
    if (useMicHold) {
      if (holding || vad.listening) {
        return vad.userSpeaking
          ? "Holding · speaking"
          : "Holding · release to send";
      }
      return "Hold mic to talk";
    }
    if (useSpaceHold) {
      if (holding || vad.listening) {
        return vad.userSpeaking
          ? "Holding Space · speaking"
          : "Holding Space · release to send";
      }
      return "Hold Space to talk";
    }
    if (vad.listening && vad.userSpeaking) return "Listening · speaking";
    if (vad.listening) return "Listening";
    return "Voice off";
  }, [
    vad.loading,
    vad.errored,
    vad.ready,
    vad.listening,
    vad.userSpeaking,
    useMicHold,
    useSpaceHold,
    holding,
  ]);

  const statusLabel =
    busy === "transcribing"
      ? "Transcribing…"
      : busy === "thinking"
        ? voiceMode === "auto"
          ? "Thinking… (say or type to interrupt)"
          : "Thinking… (type or talk to interrupt)"
        : busy === "speaking"
          ? "Speaking… (say stop or type to interrupt)"
          : micLabel;

  const micLive = vad.listening || holding || busy === "speaking";
  const micDisabled =
    vad.loading ||
    Boolean(vad.errored) ||
    !vad.ready ||
    useSpaceHold;

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="chat-brand">
          <p className="eyebrow">Phase 05 · VAD + STT + Gemma 4 + Kokoro + MCP tools</p>
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
          <span
            className={`pill ${ttsReady ? "ok" : ttsReady === false ? "bad" : ""}`}
          >
            TTS {ttsReady === null ? "…" : ttsReady ? "online" : "offline"}
          </span>
          <span
            className={`pill ${toolsReady ? "ok" : toolsReady === false ? "bad" : ""}`}
            title={
              toolsReady && toolsInfo.count !== undefined
                ? `${toolsInfo.count} MCP tools`
                : undefined
            }
          >
            Tools{" "}
            {toolsReady === null ? "…" : toolsReady ? "online" : "offline"}
          </span>
          {toolsReady && toolsInfo.os && (
            <span className="pill muted">
              {toolsInfo.dryRun ? `${toolsInfo.os} · dry run` : toolsInfo.os}
            </span>
          )}
          <span className="pill muted">{ttsVoice}</span>
          <span className="pill muted">{llmModel}</span>
          <span className="pill muted">{sttModel}</span>
        </div>
      </header>

      <section className="chat-panel" aria-label="Conversation">
        <div className="chat-toolbar">
          <p className={`mic-status ${micLive ? "live" : ""}`} role="status">
            {statusLabel}
          </p>
          <div className="toolbar-actions">
            <div
              className="voice-mode"
              role="group"
              aria-label="Voice input mode"
            >
              {voiceModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`voice-mode-btn ${voiceMode === mode.id ? "active" : ""}`}
                  aria-pressed={voiceMode === mode.id}
                  title={mode.hint}
                  onClick={() => changeVoiceMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                className="btn ghost small"
                onClick={clearChat}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="message-list" ref={listRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>
                Type or talk. Use Auto for continuous voice detection, or{" "}
                {isPhone ? "Hold mic" : "Space"} for push-to-talk. Short
                answers are spoken word-by-word; long ones get a spoken handoff
                and the full text in chat.
              </p>
              <p>
                Ask Gemma to open YouTube, search the web, play a song or draft
                an email — it happens on the computer running the tools service.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <article
                key={message.id}
                className={`bubble ${message.role} ${message.error ? "error" : ""} ${message.speaking ? "speaking" : ""}`}
              >
                <div className="bubble-meta">
                  <span>{message.role === "user" ? "You" : "Gemma"}</span>
                  {message.source === "voice" && (
                    <span className="source-tag">voice</span>
                  )}
                  {message.actions && message.actions.length > 0 && (
                    <span className="source-tag">tools</span>
                  )}
                  {message.speaking && (
                    <span className="source-tag pulse">speaking</span>
                  )}
                  {message.interrupted && (
                    <span className="source-tag interrupted">interrupted</span>
                  )}
                  {message.pending && (
                    <span className="source-tag pulse">…</span>
                  )}
                </div>
                {message.actions && message.actions.length > 0 && (
                  <ul className="tool-list" aria-label="Actions">
                    {message.actions.map((action) => (
                      <li
                        key={action.id}
                        className={`tool-chip ${action.status}`}
                        title={action.message}
                      >
                        <span className="tool-state" aria-hidden>
                          {action.status === "running"
                            ? "…"
                            : action.status === "ok"
                              ? "✓"
                              : "✕"}
                        </span>
                        <span className="tool-title">{action.title}</span>
                        <span className="tool-detail">
                          {action.status === "error"
                            ? action.message
                            : action.detail}
                        </span>
                        {action.dryRun && action.url && (
                          <a
                            className="tool-link"
                            href={action.url}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            dry run
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {message.role === "assistant" ? (
                  <MarkdownContent
                    className="bubble-text"
                    text={
                      message.content ||
                      (message.pending || message.speaking ? "…" : "")
                    }
                  />
                ) : (
                  <p className="bubble-text">
                    {message.content ||
                      (message.pending || message.speaking ? "…" : "")}
                  </p>
                )}
                {message.displayContent && (
                  <div className="display-block">
                    <p className="display-label">Full answer</p>
                    <MarkdownContent
                      className="bubble-text display-text"
                      text={message.displayContent}
                    />
                  </div>
                )}
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
            className={`btn mic ${vad.listening || holding ? "on" : ""} ${vad.userSpeaking ? "speaking" : ""}`}
            disabled={micDisabled}
            aria-pressed={vad.listening || holding}
            title={
              useSpaceHold
                ? "Hold Space to talk (works while Gemma speaks)"
                : useMicHold
                  ? "Press and hold to talk (works while Gemma speaks)"
                  : vad.listening
                    ? "Pause microphone"
                    : "Start voice input"
            }
            onClick={
              voiceMode === "auto" ? () => void vad.toggle() : undefined
            }
            onPointerDown={
              useMicHold
                ? (event) => {
                    if (micDisabled) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    void beginHold();
                  }
                : undefined
            }
            onPointerUp={useMicHold ? () => void endHold() : undefined}
            onPointerCancel={useMicHold ? () => void endHold() : undefined}
            onLostPointerCapture={useMicHold ? () => void endHold() : undefined}
            onContextMenu={
              useMicHold ? (event) => event.preventDefault() : undefined
            }
          >
            {useMicHold
              ? holding || vad.listening
                ? "Release"
                : "Hold"
              : useSpaceHold
                ? "Space"
                : vad.listening
                  ? "Mic on"
                  : "Mic"}
          </button>

          <input
            className="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              busy === "thinking" || busy === "speaking"
                ? "Interrupt with a new message…"
                : useSpaceHold
                  ? "Hold Space to talk, or type…"
                  : useMicHold
                    ? "Hold mic to talk, or type…"
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
            {busy === "thinking" || busy === "speaking" ? "Interrupt" : "Send"}
          </button>
        </form>
      </section>
    </div>
  );
}
