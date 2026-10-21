// src/background/task-end-guard.ts
//
// Issue #34 follow-up — the "task just ended" guard for the mid-task
// instruction queue.
//
// The queue is drained by the agent loop at the TOP of every step. Once the
// loop has produced its final answer (`chat-done` for a plain reply,
// `agent-done-task` for a done/fail termination) there is no step left, so
// nothing will drain the queue again.
//
// The window this module closes: the loop's final queue check happens BEFORE
// it emits its final answer, and the task's dispatch only tears down
// (in-flight bookkeeping) a few milliseconds later. An instruction that lands
// in that window would be accepted into the queue and then sit there forever:
// the user sees it as sent, the agent never answers it.
//
// The SW is the arbiter for that window:
//   - a task's final emit marks its session as ended;
//   - a `chat-instruction-add` for an ended session is rejected outright
//     (the panel falls back to a normal chat-start);
//   - an instruction that raced past the loop's final check is pulled back
//     out of the queue and handed to the panel the same way.

import type { PortMessageToPanel } from "@/types/messages";
import type { PendingInstruction } from "@/lib/sessions/types";

/**
 * Sessions whose CURRENT task has already emitted its final answer.
 *
 * Module-level (not per-port) for the same reason as `runningSessionIds`: the
 * flag belongs to the session, not to the panel that happens to be attached.
 */
const endedSessionIds = new Set<string>();

/**
 * Per-session task generation.
 *
 * A task that is superseded (the panel starts a new one while the old is
 * still winding down) can still emit its terminal message afterwards — the
 * abort path emits `agent-done-task` from the loop's `finally`, which lands
 * AFTER the new task started. Without a generation guard that late emit
 * would mark the NEW task's session as ended (closing its instruction queue)
 * and reclaim instructions belonging to it.
 *
 * Every task takes a generation number; a terminal emit only counts if its
 * generation is still the session's current one.
 */
const taskGenerations = new Map<string, number>();

/**
 * Sessions whose ended task has already handed a late instruction back to the
 * panel (`chat-instruction-rejected`).
 *
 * The panel answers a rejection by re-sending the WHOLE conversation as a new
 * chat-start — which already contains every instruction the user sent before
 * that rejection reached it. A second rejection for the same ended task would
 * make the panel send a second chat-start, which aborts the first fallback
 * task mid-flight (and its teardown then drops the session from the in-flight
 * set while the second task runs). So only the first rejection per ended task
 * is posted; later late instructions are simply removed from the queue.
 */
const rejectionPosted = new Set<string>();

/**
 * Register a new task for the session and reopen its instruction queue.
 * Returns the task's generation.
 */
export function beginTask(sessionId: string): number {
  const generation = (taskGenerations.get(sessionId) ?? 0) + 1;
  taskGenerations.set(sessionId, generation);
  endedSessionIds.delete(sessionId);
  rejectionPosted.delete(sessionId);
  return generation;
}

/** The generation of the session's current task (0 = none yet). */
export function currentGeneration(sessionId: string): number {
  return taskGenerations.get(sessionId) ?? 0;
}

/** Mark a session's task as finished — the instruction queue is now closed. */
export function markSessionEnded(sessionId: string): void {
  endedSessionIds.add(sessionId);
}

/** Has this session's current task already produced its final answer? */
export function isSessionEnded(sessionId: string): boolean {
  return endedSessionIds.has(sessionId);
}

/**
 * Reopen the queue for a session — a new (or resumed) task starts, so
 * instructions queued during it can be delivered again.
 */
export function reopenSession(sessionId: string): void {
  endedSessionIds.delete(sessionId);
  rejectionPosted.delete(sessionId);
}

/**
 * Claim the single fallback rejection of the session's ended task. Returns
 * true for the first caller only (until the next task begins) — see
 * `rejectionPosted`.
 */
export function claimRejection(sessionId: string): boolean {
  if (rejectionPosted.has(sessionId)) return false;
  rejectionPosted.add(sessionId);
  return true;
}

/**
 * Close the queue for a task and hand back anything still in it.
 *
 * No-op when the task has been superseded (a newer task took over the
 * session): that newer task owns the queue now, and its instructions must
 * not be reclaimed by the old one.
 */
export function endTask(
  deps: TaskEndGuardDeps,
  sessionId: string,
  generation: number,
): void {
  if (currentGeneration(sessionId) !== generation) return;
  markSessionEnded(sessionId);
  void reclaimLateInstructions(deps, sessionId);
}

export interface TaskEndGuardDeps {
  /** Deliver a message to the panel. */
  post: (m: PortMessageToPanel) => void;
  /** Take everything out of the session's instruction queue. */
  drainPending: (sessionId: string) => Promise<PendingInstruction[]>;
}

/**
 * Pull instructions that arrived after the loop's last queue check back out
 * of the queue and hand them to the panel, which re-sends them as a normal
 * chat-start (the same fallback as `chat-instruction-rejected`).
 *
 * Only ONE rejection is posted even when several instructions raced in: the
 * panel's fallback re-sends the whole conversation (which contains every one
 * of them), so a single chat-start covers them all. The others are drained
 * from the queue so the next chat-start's carry-over merge does not repeat
 * them.
 */
export async function reclaimLateInstructions(
  deps: TaskEndGuardDeps,
  sessionId: string,
): Promise<void> {
  try {
    const late = await deps.drainPending(sessionId);
    if (late.length === 0) return;
    // Another late instruction already triggered the panel's fallback
    // chat-start, whose payload contains these too — draining them is enough.
    if (!claimRejection(sessionId)) return;
    const first = late[0]!;
    deps.post({
      type: "chat-instruction-rejected",
      sessionId,
      chatMessageId: first.chatMessageId,
      reason: "not-streaming",
    });
  } catch (e) {
    console.warn(`[sw] late-instruction reclaim failed for session=${sessionId}:`, e);
  }
}

/**
 * The task's emit wrapper. A task's final answer closes the queue; anything
 * still in it at that moment is handed back to the panel.
 *
 * The task's generation is passed in (taken when the task was dispatched), so
 * a superseded task's late terminal emit cannot close the queue of the task
 * that replaced it.
 *
 * `isAborted` reports whether the task was stopped by the user. An aborted
 * task's terminal emit does NOT reclaim the queue: per P-MTI-9 the queue
 * survives an abort and is carried over into the user's next chat-start.
 * Reclaiming here would make the panel immediately start a new task — the
 * agent would restart on its own right after the user pressed Stop.
 */
export function makeGuardedTaskEmit(
  deps: TaskEndGuardDeps,
  sessionId: string,
  generation: number,
  isAborted: () => boolean = () => false,
): (m: PortMessageToPanel) => void {
  return (m) => {
    deps.post(m);
    if (m.type !== "chat-done" && m.type !== "agent-done-task") return;
    if (isAborted()) return;
    endTask(deps, sessionId, generation);
  };
}

/**
 * Admission check for a `chat-instruction-add`.
 *
 *   - "accept": the task is running and its queue is open.
 *   - "reject": post `chat-instruction-rejected` — the panel falls back to a
 *     normal chat-start.
 *   - "drop":   the session's ended task already handed one late instruction
 *     back; the panel's fallback chat-start carries this one too (it was sent
 *     before the panel saw the task end), so a second rejection would only
 *     start a second task that aborts the first.
 */
export function admitInstruction(
  sessionId: string,
  inFlight: boolean,
): "accept" | "reject" | "drop" {
  if (isSessionEnded(sessionId)) {
    return claimRejection(sessionId) ? "reject" : "drop";
  }
  return inFlight ? "accept" : "reject";
}

/**
 * After an accepted instruction has been written to the queue: make sure it
 * did not land in a queue nobody will drain. Returns true when it stays
 * queued for the running task.
 *
 *   - A NEW task began while the write was in flight (the panel's fallback
 *     chat-start for an earlier late instruction overtook it): that
 *     chat-start's payload already contains this instruction, so it is pulled
 *     back out silently — leaving it queued would hand it to the new task a
 *     second time (carry-over / mid-task drain).
 *   - The task ended meanwhile: pull it back out and hand it to the panel —
 *     unless the task's final emit already took it, or another late
 *     instruction already triggered the (single) fallback.
 */
export async function settleQueuedInstruction(
  deps: {
    post: (m: PortMessageToPanel) => void;
    cancelPending: (sessionId: string, chatMessageId: string) => Promise<boolean>;
  },
  sessionId: string,
  chatMessageId: string,
  addGeneration: number,
): Promise<boolean> {
  if (currentGeneration(sessionId) !== addGeneration) {
    await deps.cancelPending(sessionId, chatMessageId);
    return false;
  }
  if (!isSessionEnded(sessionId)) return true;
  const removed = await deps.cancelPending(sessionId, chatMessageId);
  if (removed && claimRejection(sessionId)) {
    deps.post({
      type: "chat-instruction-rejected",
      sessionId,
      chatMessageId,
      reason: "not-streaming",
    });
  }
  return false;
}
