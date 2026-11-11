// Issue #470 — SW arbiter for the window between a task's final emit and its
// teardown. The loop checks the instruction queue before its final answer, but
// an instruction can still land after that check and before the dispatcher
// tears down: accepted into the queue, never drained. Once a task's terminal
// emit fires, its session is latched "ended": further instruction-adds are
// rejected (the panel falls back to a normal chat-start that re-sends the whole
// conversation), and at most ONE rejection is posted per ended task.
//
// Tasks carry a generation number taken at dispatch, so a superseded task's
// late terminal emit (abort path emits from the loop's finally, after the new
// task started) can't end the NEW task.

import { updateSessionAgent } from "@/lib/sessions/storage";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { ChatInstructionRejectedMessage, PortMessageToPanel } from "@/types/messages";
import { broadcastInstructionState } from "./instruction-broadcast";

const generations = new Map<string, number>();
const ended = new Map<string, { rejected: boolean }>();
const reclaims = new Map<string, Promise<void>>();

export async function waitForTaskReclaim(sessionId: string): Promise<void> {
  await reclaims.get(sessionId);
}

/** Start (or resume) a task: bump the generation and reopen the queue. */
export function beginTask(sessionId: string): number {
  const gen = (generations.get(sessionId) ?? 0) + 1;
  generations.set(sessionId, gen);
  ended.delete(sessionId);
  return gen;
}

export function isCurrentTask(sessionId: string, gen: number): boolean {
  return generations.get(sessionId) === gen;
}

/** Check ownership inside the IDB transaction, not before an asynchronous write. */
export function updateCurrentTaskAgent(
  sessionId: string,
  gen: number,
  transform: (current: SessionAgentState | null) => SessionAgentState | null,
): Promise<boolean> {
  return updateSessionAgent(sessionId, (current) =>
    isCurrentTask(sessionId, gen) ? transform(current) : null,
  );
}

/** Latch the session ended. True only for the first end of the CURRENT task. */
export function endTask(sessionId: string, gen: number): boolean {
  if (!isCurrentTask(sessionId, gen) || ended.has(sessionId)) return false;
  ended.set(sessionId, { rejected: false });
  return true;
}

export function isTaskEnded(sessionId: string): boolean {
  return ended.has(sessionId);
}

/**
 * Whether to post a rejection now. Within an ended task only the first call
 * returns true (the panel's fallback re-sends every message at once). Sessions
 * with no ended latch (e.g. SW restarted mid-task) always reject.
 */
export function claimRejection(sessionId: string): boolean {
  const e = ended.get(sessionId);
  if (!e) return true;
  if (e.rejected) return false;
  e.rejected = true;
  return true;
}

/**
 * Issue #470 — loop emit wrapper. On the CURRENT task's terminal emit
 * (chat-done / agent-done-task) latch the session ended and reclaim any
 * instruction that raced past the loop's final queue check: pull it out of the
 * queue and hand it back to the panel via one rejection, so it is re-sent as a
 * normal chat-start instead of rotting. Abort keeps the queue (chat-start
 * carryover merges it into the user's next task, Issue #34).
 */
export function makeTaskEmit(
  port: Pick<chrome.runtime.Port, "postMessage">,
  sessionId: string,
  gen: number,
  signal: AbortSignal,
) {
  return (m: PortMessageToPanel): void => {
    // A replaced task can still finish asynchronously. Its messages must not
    // update the panel's state or be mistaken for events from the new task.
    if (!isCurrentTask(sessionId, gen)) return;
    port.postMessage(m);
    if (m.type !== "chat-done" && m.type !== "agent-done-task") return;
    if (!endTask(sessionId, gen) || signal.aborted) return;
    const reclaim = reclaimStrandedInstructions(port, sessionId, gen).catch((e) => {
      console.warn(`[sw] reclaim stranded instructions failed for session=${sessionId}:`, e);
    });
    reclaims.set(sessionId, reclaim);
    void reclaim.finally(() => {
      if (reclaims.get(sessionId) === reclaim) reclaims.delete(sessionId);
    });
  };
}

async function reclaimStrandedInstructions(
  port: Pick<chrome.runtime.Port, "postMessage">,
  sessionId: string,
  gen: number,
): Promise<void> {
  let stranded: NonNullable<SessionAgentState["pendingInstructions"]> = [];
  await updateCurrentTaskAgent(sessionId, gen, (state) => {
    stranded = state?.pendingInstructions ?? [];
    return state && stranded.length ? { ...state, pendingInstructions: [] } : null;
  });
  if (stranded.length === 0) return;
  if (!isCurrentTask(sessionId, gen)) {
    // 新任务在回收提交后启动时，先恢复队列；新任务会等待此操作完成。
    await updateSessionAgent(sessionId, (state) => state
      ? { ...state, pendingInstructions: [...stranded, ...state.pendingInstructions] }
      : null);
    return;
  }
  if (!claimRejection(sessionId)) return;
  const reply: ChatInstructionRejectedMessage = {
    type: "chat-instruction-rejected",
    sessionId,
    chatMessageId: stranded[0]!.chatMessageId,
    reason: "not-streaming",
  };
  port.postMessage(reply);
  await broadcastInstructionState((m) => {
    if (isCurrentTask(sessionId, gen)) port.postMessage(m);
  }, sessionId);
}

/** Test-only reset. */
export function __resetTaskEndGuard(): void {
  generations.clear();
  ended.clear();
  reclaims.clear();
}
