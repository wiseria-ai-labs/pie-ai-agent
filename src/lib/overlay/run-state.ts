// Overlay task run-state — what the in-page capsule needs to know, derived
// from the agent's port events.
//
// The overlay document is a *panel client* (it owns a chat-stream port), but
// the document dies with the page. The capsule therefore cannot be driven by
// the document: after a navigation the SW must still be able to answer "is
// there a task on this tab, and what is it doing?". This module keeps that
// state in the SW and is deliberately pure (no chrome.* calls) so the whole
// derivation is unit-testable.
//
// Two responsibilities:
//   1. capsule snapshot for the page (running / done / stopped / failed);
//   2. the display messages to persist when the run finishes while DETACHED
//      (the document that would normally persist them is gone).

import type { DisplayMessage, PortMessageToPanel } from "@/types";
import { getToolClass } from "@/lib/agent/tool-names";

export type OverlayRunStatus = "run" | "done" | "stopped" | "failed";

export interface OverlayRunStep {
  tool: string;
  /** Short human-readable hint: `click · “发送”`. Untrusted page text never
   *  enters here — only the tool name and a bounded args summary. */
  label: string;
  status: "pending" | "ok" | "error";
}

export interface OverlayRun {
  sessionId: string;
  /** Tab the capsule is pinned to (the one the user is looking at). */
  tabId: number;
  startedAt: number;
  /** True once the overlay document's port died mid-task (page navigation,
   *  tab closed, extension reloaded). Persistence + capsule take over. */
  detached: boolean;
  status: OverlayRunStatus;
  steps: OverlayRunStep[];
  /** Assistant text streamed since the last flush. */
  accumulated: string;
  /** Display messages produced by this run so far (only used when detached). */
  pending: DisplayMessage[];
  /** Steps the capsule popover lists (prototype: 悬停胶囊看完整步骤). */
  doneLabel?: string;
}

const MAX_STEPS = 12;
const MAX_LABEL = 60;

export function createOverlayRun(sessionId: string, tabId: number, now = Date.now()): OverlayRun {
  return {
    sessionId,
    tabId,
    startedAt: now,
    detached: false,
    status: "run",
    steps: [],
    accumulated: "",
    pending: [],
  };
}

/** Bound + flatten an args object into a one-line hint. */
export function summarizeToolArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return "";
  }
  if (!text || text === "{}") return "";
  // Prefer a human-meaningful field when the tool carries one.
  try {
    const o = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : null;
    if (o) {
      for (const key of ["label", "text", "selector", "url", "target", "query", "instruction"]) {
        const v = o[key];
        if (typeof v === "string" && v.trim()) {
          text = v.trim();
          break;
        }
      }
    }
  } catch {
    // keep the JSON fallback
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_LABEL ? `${oneLine.slice(0, MAX_LABEL)}…` : oneLine;
}

export function stepLabel(tool: string, args: unknown): string {
  const hint = summarizeToolArgs(args);
  return hint ? `${tool} · ${hint}` : tool;
}

/** Flush streamed assistant text into the pending display list. */
function flushAssistant(run: OverlayRun): OverlayRun {
  const text = run.accumulated;
  if (!text.trim()) return { ...run, accumulated: "" };
  return { ...run, accumulated: "", pending: [...run.pending, { role: "assistant", content: text }] };
}

/**
 * Apply one port event. Returns the run unchanged (same reference) when the
 * event is irrelevant, so callers can skip work.
 */
export function applyOverlayEmit(run: OverlayRun, msg: PortMessageToPanel): OverlayRun {
  switch (msg.type) {
    case "chat-chunk":
      return { ...run, accumulated: run.accumulated + msg.text };
    case "thinking-chunk":
      return run; // capsule never shows reasoning
    case "chat-done":
      return { ...flushAssistant(run), status: "done", doneLabel: undefined };
    case "agent-step": {
      // A step starts a new assistant turn only when it is the first event of
      // one — the loop flushes accumulated text before every step.
      const base = flushAssistant(run);
      const entry: OverlayRunStep = {
        tool: msg.tool,
        label: stepLabel(msg.tool, msg.args),
        status: msg.status,
      };
      const steps = [...base.steps, entry].slice(-MAX_STEPS);
      const pending: DisplayMessage[] = [
        ...base.pending,
        {
          role: "agent-step",
          stepIndex: msg.stepIndex,
          tool: msg.tool,
          args: msg.args,
          status: msg.status,
          ...(msg.observation ? { observation: msg.observation } : {}),
        },
      ];
      // Tab following — the loop stamps the focused tab on every step so the
      // capsule can hop tabs with the agent.
      const tabId = typeof msg.focusTabId === "number" ? msg.focusTabId : base.tabId;
      return { ...base, steps, pending, tabId };
    }
    case "agent-done-task": {
      const base = flushAssistant(run);
      return {
        ...base,
        status: msg.success ? "done" : "failed",
        doneLabel: msg.summary,
        pending: [
          ...base.pending,
          {
            role: "agent-summary",
            success: msg.success,
            summary: msg.summary,
            ...(msg.summaryKey ? { summaryKey: msg.summaryKey } : {}),
            stepCount: msg.stepCount,
          },
        ],
      };
    }
    case "chat-error": {
      const base = flushAssistant(run);
      return { ...base, status: "failed", doneLabel: msg.error };
    }
    // Pie 2.0 memory rows — they are display messages like any other, so a
    // detached run must persist them too (the chip sits after the answer).
    case "memory-used": {
      if (msg.items.length === 0) return run;
      const base = flushAssistant(run);
      return { ...base, pending: [...base.pending, { role: "memory-used", items: msg.items }] };
    }
    case "memory-event": {
      const base = flushAssistant(run);
      return {
        ...base,
        pending: [
          ...base.pending,
          {
            role: "memory-event",
            eventId: msg.eventId,
            kind: msg.kind,
            label: msg.label,
            ...(msg.encrypted ? { encrypted: true } : {}),
            count: msg.count,
          },
        ],
      };
    }
    default:
      return run;
  }
}

export function markStopped(run: OverlayRun): OverlayRun {
  if (run.status !== "run") return run;
  return { ...flushAssistant(run), status: "stopped" };
}

/** True when this event means the task is over. */
export function isTerminalEmit(msg: PortMessageToPanel): boolean {
  return msg.type === "chat-done" || msg.type === "agent-done-task" || msg.type === "chat-error";
}

/** The step the capsule headline shows (the newest one). */
export function currentStepLabel(run: OverlayRun): string {
  const last = run.steps[run.steps.length - 1];
  return last ? last.label : "";
}

/** Latest step list, oldest first, deduped consecutive repeats. */
export function capsuleSteps(run: OverlayRun): string[] {
  const out: string[] = [];
  for (const s of run.steps) {
    if (out[out.length - 1] !== s.label) out.push(s.label);
  }
  return out;
}

/**
 * Display messages to append to the session when a detached run ends.
 *
 * Only meaningful when the overlay document is gone — otherwise it persists
 * the same messages itself and a second write would duplicate them.
 */
export function detachedMessagesToPersist(run: OverlayRun): DisplayMessage[] {
  if (!run.detached) return [];
  if (run.status === "run") return [];
  return run.pending;
}

/** Build the display messages a disconnected overlay would have shown. */
export function displayMessagesForRun(run: OverlayRun): DisplayMessage[] {
  return run.pending;
}

export function isWriteStep(tool: string): boolean {
  return getToolClass(tool) === "write";
}
