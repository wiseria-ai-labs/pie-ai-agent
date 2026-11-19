// Live fan-out of an overlay run to a side-panel port.
//
// An overlay run outlives its document (navigation, tab close, handoff), but
// the side panel is a second legitimate client of the same session and the
// spec's core promise is that the panel can pick the conversation up *while it
// runs*. The SW therefore logs every emit of the run and replays the log the
// moment a panel port attaches, so the panel continues the turn instead of
// waiting for the detached run to persist at the end.
//
// Deliberately pure (no chrome.*): the SW wrapper owns port identity and
// failure handling; this module owns the "what does a late attach see" rule,
// which is the part worth testing.

import type { ChatAttachMessage, PortMessageToPanel } from "@/types";

export interface PostTarget {
  postMessage(msg: unknown): void;
}

export interface PanelFanout {
  panel: PostTarget | null;
  /** Every emit of this run, in order. Unbounded within one task by design —
   *  bounded in practice by a task's stream, and dropped at the terminal emit.
   *  ponytail: cap + replay-from-pending if a single task ever streams for
   *  hours and the duplication with `run.pending` matters. */
  log: PortMessageToPanel[];
}

export function createPanelFanout(): PanelFanout {
  return { panel: null, log: [] };
}

function post(target: PostTarget, msg: unknown): boolean {
  try {
    target.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind a side-panel port to a live run: enter streaming, then replay what the
 * run has emitted so far. Returns false when the panel port is already dead
 * (the caller then leaves persistence to the SW).
 */
export function attachPanel(
  fanout: PanelFanout,
  panel: PostTarget,
  sessionId: string,
): boolean {
  if (!post(panel, { type: "chat-attach", sessionId } satisfies ChatAttachMessage)) {
    return false;
  }
  for (const msg of fanout.log) {
    if (!post(panel, msg)) return false;
  }
  fanout.panel = panel;
  return true;
}

/** Feed one emit to the panel (and remember it for a later attach). */
export function postToPanel(fanout: PanelFanout, msg: PortMessageToPanel): void {
  fanout.log.push(msg);
  if (!fanout.panel) return;
  if (!post(fanout.panel, msg)) fanout.panel = null;
}

export function detachPanel(fanout: PanelFanout, panel: PostTarget): void {
  if (fanout.panel === panel) fanout.panel = null;
}

export function panelAttached(fanout: PanelFanout): boolean {
  return fanout.panel !== null;
}

/** Drop the replay log once the run is over (it can be large — one turn of
 *  streamed chunks — and has no use after the terminal emit). */
export function clearPanelLog(fanout: PanelFanout): void {
  fanout.log.length = 0;
  fanout.panel = null;
}
