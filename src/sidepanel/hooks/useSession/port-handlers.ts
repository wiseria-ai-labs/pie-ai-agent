import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DisplayMessage, PortMessageToPanel, PortMessageToWorker, QuoteAddedMessage } from "@/types";
import { EMPTY_SLOT, withSlot, type SessionRuntimeSlot } from "./runtime-map";
import { resolveDownload } from "./download-pending";

export interface CreatePortHandlersDeps {
  slotsRef: MutableRefObject<Map<string, SessionRuntimeSlot>>;
  setSlots: Dispatch<SetStateAction<Map<string, SessionRuntimeSlot>>>;
  persistMessages: (sessionId: string, messages: DisplayMessage[]) => Promise<void>;
  /** Issue #34 — ref to postWithReconnect; populated after hook wires up the
   *  port machinery (avoids circular useMemo dep). Used by
   *  chat-instruction-rejected to fall back to chat-start. */
  postMessageRef?: MutableRefObject<((sessionId: string, payload: PortMessageToWorker) => boolean) | null>;
  /** #30 migration bridge — sync legacy single-tenant state while callers
   *  still read from it. Removed in Task 9b. */
  legacy?: {
    sessionIdRef: MutableRefObject<string | null>;
    setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
    messagesRef: MutableRefObject<DisplayMessage[]>;
    setStreaming: Dispatch<SetStateAction<boolean>>;
    streamingRef: MutableRefObject<boolean>;
    setStreamingText: Dispatch<SetStateAction<string>>;
    setError: Dispatch<SetStateAction<string | null>>;
    setToast: Dispatch<SetStateAction<{ level: "warn" | "error" | "info"; text: string } | null>>;
    accumulatedRef: MutableRefObject<string>;
    streamFinishedRef: MutableRefObject<boolean>;
  };
}

export interface PortHandlers {
  /** Single instance, attached to every port. Routes by `message.sessionId`. */
  handleMessage: (msg: PortMessageToPanel) => void;
  /** Per-port closure capturing sessionId. Created fresh in connectPortFor. */
  makeDisconnectHandler: (sessionId: string) => () => void;
}

export function createPortHandlers(deps: CreatePortHandlersDeps): PortHandlers {
  const { slotsRef, setSlots, persistMessages, postMessageRef, legacy } = deps;

  /** Sync write to slotsRef (Bug-fix-A truth source) + setSlots for React commit. */
  function patchSlot(
    id: string,
    patch:
      | Partial<SessionRuntimeSlot>
      | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
  ) {
    slotsRef.current = withSlot(slotsRef.current, id, patch);
    setSlots(slotsRef.current);

    // #30 migration bridge — sync legacy single-tenant state while callers
    // still read from it (removed in Task 9b).
    if (legacy && id === legacy.sessionIdRef.current) {
      const slot = slotsRef.current.get(id);
      if (slot) {
        legacy.streamingRef.current = slot.streaming;
        legacy.setStreaming(slot.streaming);
        legacy.setStreamingText(slot.streamingText);
        legacy.setError(slot.error);
        legacy.setToast(slot.toast);
        legacy.accumulatedRef.current = slot.accumulated;
        legacy.streamFinishedRef.current = slot.streamFinished;
        // messages: only set if they differ (avoids unnecessary re-renders)
        if (legacy.messagesRef.current !== slot.messages) {
          legacy.messagesRef.current = slot.messages;
          legacy.setMessages(slot.messages);
        }
      }
    }
  }

  const insertBeforeInstructions = (
    base: DisplayMessage[],
    entry: DisplayMessage,
    instructionIds: ReadonlySet<string>,
  ): DisplayMessage[] => {
    const index = base.findIndex(
      (m) => m.role === "user" && m.id !== undefined && instructionIds.has(m.id),
    );
    return index < 0
      ? [...base, entry]
      : [...base.slice(0, index), entry, ...base.slice(index)];
  };

  const buildAssistant = (
    base: DisplayMessage[],
    accumulated: string,
    thinking: string,
    instructionIds: ReadonlySet<string>,
  ): { next: DisplayMessage[]; flushed: boolean } => {
    if (!accumulated.trim() && !thinking.trim()) return { next: base, flushed: false };
    const m: DisplayMessage = {
      role: "assistant",
      content: accumulated,
      ...(thinking.trim() ? { thinking } : {}),
    };
    return { next: insertBeforeInstructions(base, m, instructionIds), flushed: true };
  };

  const handleMessage = (msg: PortMessageToPanel) => {
    // needs-file-access has no sessionId; it is handled by useFileAccessPrompt separately.
    if (msg.type === "needs-file-access") return;

    const id = msg.sessionId;

    if (msg.type === "chat-ratelimit-wait") {
      patchSlot(id, { ratelimitResumeAt: msg.resumeAt });
      return;
    }

    if (msg.type === "chat-chunk") {
      patchSlot(id, (prev) => {
        const accumulated = prev.accumulated + msg.text;
        return { accumulated, streamingText: accumulated, ratelimitResumeAt: null };
      });
      return;
    }
    if (msg.type === "thinking-chunk") {
      patchSlot(id, (prev) => ({
        streamingThinking: prev.streamingThinking + msg.text,
        ratelimitResumeAt: null,
      }));
      return;
    }
    if (msg.type === "chat-done") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const baseMessages = prev?.messages ?? [];
      const { next } = buildAssistant(
        baseMessages, accumulated, thinking, prev?.unconsumedInstructionIds ?? EMPTY_SLOT.unconsumedInstructionIds,
      );
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
        ratelimitResumeAt: null,
      });
      void persistMessages(id, next);
      return;
    }

    if (msg.type === "chat-error") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const baseMessages = prev?.messages ?? [];
      const { next } = buildAssistant(
        baseMessages, accumulated, thinking, prev?.unconsumedInstructionIds ?? EMPTY_SLOT.unconsumedInstructionIds,
      );
      patchSlot(id, {
        error: msg.error,
        errorKind: msg.kind ?? null,
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
        ratelimitResumeAt: null,
      });
      void persistMessages(id, next);
      return;
    }

    if (msg.type === "agent-step") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";

      // 1. Flush pending accumulated text / thinking first (legacy behavior
      //    preserved from useSession.ts:349-365).
      const instructionIds = prev?.unconsumedInstructionIds ?? EMPTY_SLOT.unconsumedInstructionIds;
      const { next: flushedMsgs, flushed } = buildAssistant(baseMessages, accumulated, thinking, instructionIds);
      let nextMessages: DisplayMessage[] = flushedMsgs;

      // 2. Either update the last step before queued instructions, or insert
      //    a new one there. The user may have queued input between step events.
      const { stepIndex, tool, args, resolvedElement, status, observation, image, progress, remote } = msg;
      const firstQueued = nextMessages.findIndex(
        (m) => m.role === "user" && m.id !== undefined && instructionIds.has(m.id),
      );
      const tail = (firstQueued < 0 ? nextMessages.length : firstQueued) - 1;
      const last = tail >= 0 ? nextMessages[tail] : null;
      // Remote steps are emitted once at status "ok" and never in-place-updated.
      // stepIndex is the loop iteration, so two same-named remotes in one turn
      // (Hermes multi-tool / consecutive OpenRouter web_search) share it —
      // matching on stepIndex+tool would collapse them into one row.
      const matchesTail =
        last &&
        last.role === "agent-step" &&
        last.stepIndex === stepIndex &&
        last.tool === tool &&
        !remote &&
        !last.remote;

      const stepEntry: DisplayMessage = {
        role: "agent-step",
        stepIndex,
        tool,
        args,
        resolvedElement,
        status,
        observation,
        ...(remote && { remote: true as const }),
        ...(image && { image }),
        ...(progress && { progress }),
      };

      if (matchesTail) {
        nextMessages = [...nextMessages.slice(0, tail), stepEntry, ...nextMessages.slice(tail + 1)];
      } else {
        nextMessages = insertBeforeInstructions(nextMessages, stepEntry, instructionIds);
      }

      patchSlot(id, {
        messages: nextMessages,
        ratelimitResumeAt: null,
        ...(flushed ? { accumulated: "", streamingText: "", streamingThinking: "" } : {}),
      });
      return;
    }

    if (msg.type === "agent-done-task") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      // Mid-stream abort lands here (not chat-done): the loop is cut off while
      // assistant text/thinking is still streaming. Flush that in-flight turn
      // into a real message first — same as chat-done / agent-step / disconnect —
      // otherwise the reset below discards what the user just saw on screen.
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const instructionIds = prev?.unconsumedInstructionIds ?? EMPTY_SLOT.unconsumedInstructionIds;
      const { next: flushedMsgs } = buildAssistant(baseMessages, accumulated, thinking, instructionIds);
      const next = insertBeforeInstructions(
        flushedMsgs,
        {
          role: "agent-summary",
          success: msg.success,
          summary: msg.summary,
          // #354 — forward the optional i18n key so the panel translates
          // system abort summaries at render time (undefined for LLM summaries).
          ...(msg.summaryKey ? { summaryKey: msg.summaryKey } : {}),
          stepCount: msg.stepCount,
        },
        instructionIds,
      );
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
        ratelimitResumeAt: null,
      });
      void persistMessages(id, next);
      return;
    }

    if (msg.type === "session-confirm-request") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      for (let i = baseMessages.length - 1; i >= 0; i--) {
        const m = baseMessages[i]!;
        if (m.role === "session-confirm" && m.confirmationId === msg.confirmationId) {
          return;
        }
      }
      const entry: DisplayMessage = {
        role: "session-confirm",
        confirmationId: msg.confirmationId,
        kind: msg.kind,
        payload: msg.payload,
        resolved: undefined,
      };
      patchSlot(id, { messages: [...baseMessages, entry] });
      return;
    }

    if (msg.type === "session-toast") {
      patchSlot(id, { toast: { level: msg.level, text: msg.text } });
      return;
    }

    if (msg.type === "quote-added") {
      patchSlot(id, (prev) => ({ quotes: [...prev.quotes, (msg as QuoteAddedMessage).quote] }));
      return;
    }

    if (msg.type === "agent-usage") {
      patchSlot(id, {
        usage: {
          lastInputTokens: msg.lastInputTokens,
          lastOutputTokens: msg.lastOutputTokens,
          totalInputTokens: msg.totalInputTokens,
          totalOutputTokens: msg.totalOutputTokens,
          ...(msg.lastCachedTokens != null
            ? { lastCachedTokens: msg.lastCachedTokens }
            : {}),
          ...(msg.lastPromptTotalTokens != null
            ? { lastPromptTotalTokens: msg.lastPromptTotalTokens }
            : {}),
          ...(msg.totalCachedTokens != null && msg.totalPromptTokens != null
            ? {
                totalCachedTokens: msg.totalCachedTokens,
                totalPromptTokens: msg.totalPromptTokens,
              }
            : {}),
        },
      });
      return;
    }

    // A drain starts a new LLM turn, even when it happens before the first
    // request and there is no assistant text to flush yet.
    if (msg.type === "chat-instructions-consumed") {
      const prev = slotsRef.current.get(id);
      if (!prev) return;
      const consumed = new Set(msg.chatMessageIds.filter(
        (chatMessageId) => !prev.settledInstructionIds.has(chatMessageId) ||
          prev.unconsumedInstructionIds.has(chatMessageId),
      ));
      if (consumed.size === 0) return;
      const unconsumedInstructionIds = new Set(prev.unconsumedInstructionIds);
      const cancelledInstructionMessages = new Map(prev.cancelledInstructionMessages);
      const settledInstructionIds = new Set([...prev.settledInstructionIds, ...consumed]);
      const pendingByChatMessageId = new Map(prev.pendingByChatMessageId);
      let messages = prev.messages;
      const queuedIds = [...unconsumedInstructionIds];
      // Cancellation is optimistic. If drain won the race, restore the user
      // bubble in queue order: the model will in fact see that instruction.
      for (const [index, chatMessageId] of queuedIds.entries()) {
        const cancelled = cancelledInstructionMessages.get(chatMessageId);
        if (!cancelled || !consumed.has(chatMessageId)) continue;
        const followingIds = new Set(queuedIds.slice(index + 1));
        messages = insertBeforeInstructions(messages, cancelled, followingIds);
      }
      const beforeIds = new Set([...unconsumedInstructionIds, ...consumed]);
      const { next } = buildAssistant(messages, prev.accumulated, prev.streamingThinking, beforeIds);
      for (const chatMessageId of consumed) {
        unconsumedInstructionIds.delete(chatMessageId);
        cancelledInstructionMessages.delete(chatMessageId);
        pendingByChatMessageId.delete(chatMessageId);
      }
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingText: "",
        streamingThinking: "",
        unconsumedInstructionIds,
        cancelledInstructionMessages,
        settledInstructionIds,
        pendingByChatMessageId,
      });
      // A cancelled bubble was already removed from storage. Restore it there
      // too if the SW drained it before cancellation reached the queue.
      if (messages !== prev.messages) void persistMessages(id, next);
      return;
    }

    // Issue #34 — SW → panel: update pending instruction state for this session.
    if (msg.type === "chat-instruction-state") {
      const map = new Map<string, { createdAt: number }>();
      const settled = slotsRef.current.get(id)?.settledInstructionIds;
      for (const p of msg.pending) {
        if (!settled?.has(p.chatMessageId)) {
          map.set(p.chatMessageId, { createdAt: p.createdAt });
        }
      }
      patchSlot(msg.sessionId, { pendingByChatMessageId: map });
      return;
    }

    // A late rejection may refer to a cancelled instruction. Keep its ID
    // until the task settles so it can still trigger a resend of its siblings.
    if (msg.type === "chat-instruction-rejected") {
      const slot = slotsRef.current.get(id);
      if (!slot || !slot.unconsumedInstructionIds.has(msg.chatMessageId)) return;
      const { next, flushed } = buildAssistant(
        slot.messages, slot.accumulated, slot.streamingThinking, slot.unconsumedInstructionIds,
      );
      const flat = next.filter(
        (m): m is Extract<DisplayMessage, { role: "user" | "assistant" }> =>
          m.role === "user" || m.role === "assistant",
      );
      const isWaiting = (m: (typeof flat)[number]) =>
        m.role === "user" && m.id !== undefined && slot.unconsumedInstructionIds.has(m.id);
      const waiting = flat.filter(isWaiting);
      // The current task must be a user message. Keep all still-waiting turns
      // together at the end even if an older display snapshot is out of order.
      const ordered = [...flat.filter((m) => !isWaiting(m)), ...waiting];
      const chatMessages = ordered.map((m) => ({
        role: m.role,
        content: m.role === "user" && m.expandedForLLM ? m.expandedForLLM : m.content,
        ...(isWaiting(m) && m.role === "user" && m.attachments?.length
          ? { attachments: m.attachments }
          : {}),
      }));
      patchSlot(id, {
        messages: next,
        streaming: waiting.length > 0,
        streamFinished: waiting.length === 0,
        accumulated: "",
        streamingText: "",
        streamingThinking: "",
        error: null,
        errorKind: null,
        pendingByChatMessageId: new Map(),
        unconsumedInstructionIds: new Set(),
        cancelledInstructionMessages: new Map(),
        settledInstructionIds: new Set([...slot.settledInstructionIds, ...slot.unconsumedInstructionIds]),
      });
      if (flushed) void persistMessages(id, next);
      if (waiting.length > 0) {
        postMessageRef?.current?.(id, {
          type: "chat-start",
          messages: chatMessages,
          sessionId: id,
        });
      }
      return;
    }

    if (msg.type === "file-output") {
      const prev = slotsRef.current.get(msg.sessionId);
      const baseMessages = prev?.messages ?? [];
      // de-dup by artifactId (a re-emit shouldn't double-card)
      if (baseMessages.some((m) => m.role === "file-output" && m.artifactId === msg.artifactId)) return;
      const entry: DisplayMessage = {
        role: "file-output",
        artifactId: msg.artifactId,
        filename: msg.filename,
        mime: msg.mime,
        size: msg.size,
        preview: msg.preview,
        totalLines: msg.totalLines,
      };
      patchSlot(msg.sessionId, { messages: [...baseMessages, entry] });
      return;
    }

    if (msg.type === "file-output-result") {
      resolveDownload(msg.artifactId, { status: msg.status });
      return;
    }

    // Subsequent branches added in Tasks 2c–2g.
  };

  const makeDisconnectHandler = (sessionId: string) => {
    return () => {
      const slot = slotsRef.current.get(sessionId);
      if (!slot || slot.streamFinished) return;
      const { next } = buildAssistant(
        slot.messages, slot.accumulated, slot.streamingThinking, slot.unconsumedInstructionIds,
      );
      patchSlot(sessionId, {
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(sessionId, next);
    };
  };

  return { handleMessage, makeDisconnectHandler };
}
