// Overlay document session runtime.
//
// Deliberately smaller than the side panel's useSession: the overlay is a
// one-conversation surface with no mid-task instruction queue, no pin bar, no
// file artifacts. What it must get right:
//
//   - it OWNS the chat-stream port, which is why closing the overlay (Esc /
//     outside click) hides instead of unmounting while a task runs;
//   - a task may already be running when this document mounts (re-opened after
//     a navigation); then it is a VIEWER — it renders the stream but leaves
//     persistence to the SW's run mirror.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/model-router";
import type { DisplayMessage, PortMessageToPanel, PortMessageToWorker } from "@/types";
import type { MemoryEntry } from "@/lib/memory/types";
import type { OverlayTask } from "@/lib/overlay/protocol";
import { getSessionMeta, persistSessionMessages } from "@/lib/sessions/storage";
import { deriveTitleFromMessages } from "@/lib/sessions/title";
import { swPort } from "@/lib/sw-connection/manager";

export interface OverlaySendInput {
  content: string;
  expandedForLLM?: string;
  editableSelection?: boolean;
  /** Pie 2.0 memory — overlay prefetch result for this turn (spec §5.5). */
  memoryPick?: MemoryEntry[];
  memoryPickAsOf?: number;
  /** Structured selection task; the SW builds the English instruction + wire. */
  overlayTask?: OverlayTask;
}

export interface OverlaySessionApi {
  ready: boolean;
  messages: DisplayMessage[];
  streaming: boolean;
  streamingText: string;
  streamingThinking: string;
  error: string | null;
  /** The run needs the side panel (a HITL card); the panel was opened. */
  panelNotice: "panel-request" | null;
  send: (input: OverlaySendInput) => void;
  abort: () => void;
  reload: () => Promise<void>;
}

function toChatMessages(
  messages: DisplayMessage[],
  lastWireContent?: string,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.expandedForLLM ?? m.content });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
    }
  }
  // The last user turn carries the selection wrappers (expandedForLLM); the
  // caller supplies that string directly so wrappers survive the round trip.
  if (lastWireContent !== undefined && out.length > 0) {
    const last = out[out.length - 1];
    if (last.role === "user") last.content = lastWireContent;
  }
  return out;
}

export function useOverlaySession(args: {
  sessionId: string;
  tabId: number;
  runningElsewhere: boolean;
}): OverlaySessionApi {
  const { sessionId, tabId } = args;
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<"panel-request" | null>(null);

  const messagesRef = useRef<DisplayMessage[]>([]);
  const accumulatedRef = useRef("");
  const thinkingRef = useRef("");
  /** This document started the current task (and therefore persists it). */
  const startedHereRef = useRef(false);
  const runningElsewhereRef = useRef(args.runningElsewhere);

  const patchMessages = useCallback((next: DisplayMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const persist = useCallback(
    (next: DisplayMessage[]) => {
      if (!startedHereRef.current) return; // viewer mode → SW owns persistence
      void persistSessionMessages(sessionId, next).catch((e) => {
        console.warn("[overlay] persist failed:", e);
      });
    },
    [sessionId],
  );

  const reload = useCallback(async () => {
    const meta = await getSessionMeta(sessionId).catch(() => null);
    if (!meta) return;
    patchMessages(meta.messages ?? []);
  }, [sessionId, patchMessages]);

  const flushAssistant = useCallback((): DisplayMessage[] => {
    const text = accumulatedRef.current;
    const thinking = thinkingRef.current;
    accumulatedRef.current = "";
    thinkingRef.current = "";
    setStreamingText("");
    setStreamingThinking("");
    if (!text.trim() && !thinking.trim()) return messagesRef.current;
    const entry: DisplayMessage = {
      role: "assistant",
      content: text,
      ...(thinking.trim() ? { thinking } : {}),
    };
    const next = [...messagesRef.current, entry];
    patchMessages(next);
    return next;
  }, [patchMessages]);

  const handlePortMessage = useCallback(
    (msg: PortMessageToPanel) => {
      if (msg.type === "chat-chunk") {
        accumulatedRef.current += msg.text;
        setStreamingText(accumulatedRef.current);
        return;
      }
      if (msg.type === "thinking-chunk") {
        thinkingRef.current += msg.text;
        setStreamingThinking(thinkingRef.current);
        return;
      }
      if (msg.type === "chat-done") {
        const next = flushAssistant();
        setStreaming(false);
        setPanelNotice(null);
        persist(next);
        if (!startedHereRef.current) void reload();
        return;
      }
      if (msg.type === "chat-error") {
        const next = flushAssistant();
        setStreaming(false);
        setPanelNotice(null);
        setError(msg.error);
        persist(next);
        if (!startedHereRef.current) void reload();
        return;
      }
      if (msg.type === "agent-step") {
        const base = flushAssistant();
        const step: DisplayMessage = {
          role: "agent-step",
          stepIndex: msg.stepIndex,
          tool: msg.tool,
          args: msg.args,
          status: msg.status,
          ...(msg.observation ? { observation: msg.observation } : {}),
          ...(msg.remote ? { remote: true as const } : {}),
        };
        // Replace the in-progress row for the same step instead of stacking
        // pending → ok pairs.
        const last = base[base.length - 1];
        const next =
          last?.role === "agent-step" &&
          last.stepIndex === step.stepIndex &&
          last.tool === step.tool &&
          !last.remote &&
          !step.remote
            ? [...base.slice(0, -1), step]
            : [...base, step];
        patchMessages(next);
        persist(next);
        return;
      }
      if (msg.type === "agent-done-task") {
        const base = flushAssistant();
        const next: DisplayMessage[] = [
          ...base,
          {
            role: "agent-summary",
            success: msg.success,
            summary: msg.summary,
            ...(msg.summaryKey ? { summaryKey: msg.summaryKey } : {}),
            stepCount: msg.stepCount,
          },
        ];
        patchMessages(next);
        setStreaming(false);
        setPanelNotice(null);
        persist(next);
        if (!startedHereRef.current) void reload();
        return;
      }
      if (msg.type === "session-toast") {
        setError(msg.text);
        return;
      }
      // 2.0 memory — the chip under the answer, and remember/forget rows. The
      // SW emitted the chip right before the turn's terminal event, so the
      // answer text is still in the accumulator and must be flushed first.
      if (msg.type === "memory-used") {
        if (msg.items.length === 0) return;
        const base = flushAssistant();
        const next: DisplayMessage[] = [...base, { role: "memory-used", items: msg.items }];
        patchMessages(next);
        persist(next);
        return;
      }
      if (msg.type === "memory-event") {
        const base = flushAssistant();
        const next: DisplayMessage[] = [
          ...base,
          {
            role: "memory-event",
            eventId: msg.eventId,
            kind: msg.kind,
            label: msg.label,
            ...(msg.encrypted ? { encrypted: true as const } : {}),
            count: msg.count,
          },
        ];
        patchMessages(next);
        persist(next);
        return;
      }
      // 2.0 overlay — the run needs a HITL card the page surface can't show;
      // the SW opened the side panel on this session.
      if (msg.type === "overlay-notice") {
        setPanelNotice(msg.notice);
        return;
      }
      // Everything else (quotes, usage, instructions, HITL cards, file output)
      // belongs to the side panel — the overlay stays a conversation.
    },
    [flushAssistant, patchMessages, persist, reload],
  );

  const handlePortMessageRef = useRef(handlePortMessage);
  handlePortMessageRef.current = handlePortMessage;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reload();
      if (cancelled) return;
      setReady(true);
    })();

    const unsubscribe = swPort.connect(sessionId, {
      onMessage: (msg) => handlePortMessageRef.current(msg),
      onDisconnect: () => {
        // Port died mid-stream without a terminal emit (SW restart). Keep what
        // the user already saw; the panel-side paused affordance lives there.
        const next = flushAssistant();
        setStreaming(false);
        startedHereRef.current = false;
        if (next !== messagesRef.current) void persistSessionMessages(sessionId, next).catch(() => {});
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Rehydrate when the SW's run mirror finishes a task this document didn't
  // start (viewer mode): the SW persisted the messages.
  useEffect(() => {
    if (runningElsewhereRef.current && !streaming && ready) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const send = useCallback(
    (input: OverlaySendInput) => {
      const content = input.content.trim();
      if (!content || streaming) return;
      const isFirstMessage = messagesRef.current.length === 0;
      const userMessage: DisplayMessage = {
        role: "user",
        content,
        ...(input.expandedForLLM !== undefined ? { expandedForLLM: input.expandedForLLM } : {}),
      };
      const next = [...messagesRef.current, userMessage];
      patchMessages(next);
      accumulatedRef.current = "";
      thinkingRef.current = "";
      setStreamingText("");
      setStreamingThinking("");
      setStreaming(true);
      setError(null);
      setPanelNotice(null);
      startedHereRef.current = true;

      const fallbackTitle = isFirstMessage ? deriveTitleFromMessages(next) : undefined;
      const sent = swPort.send(sessionId, {
        type: "chat-start",
        messages: toChatMessages(next, input.expandedForLLM ?? content),
        sessionId,
        overlayTabId: tabId,
        anchorTabId: tabId,
        ...(input.editableSelection ? { editableSelection: true } : {}),
        ...(input.memoryPick && input.memoryPick.length > 0
          ? { memoryPick: input.memoryPick }
          : {}),
        ...(input.memoryPickAsOf !== undefined ? { memoryPickAsOf: input.memoryPickAsOf } : {}),
        ...(input.overlayTask ? { overlayTask: input.overlayTask } : {}),
        ...(fallbackTitle !== undefined ? { fallbackTitle } : {}),
      } satisfies PortMessageToWorker);

      if (!sent) {
        setStreaming(false);
        setError("background_unavailable");
        return;
      }
      void persistSessionMessages(sessionId, next).catch(() => {});
    },
    [patchMessages, persist, sessionId, streaming, tabId],
  );

  const abort = useCallback(() => {
    swPort.send(sessionId, { type: "chat-abort" } satisfies PortMessageToWorker);
  }, [sessionId]);

  return {
    ready,
    messages,
    streaming,
    streamingText,
    streamingThinking,
    error,
    panelNotice,
    send,
    abort,
    reload,
  };
}
