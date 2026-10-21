import type { PendingInstruction } from "./types";
import { emptySessionAgentState, getSessionAgent, updateSessionAgent } from "./storage";

// Mid-task instruction queue (Issue #34). Every mutation is an atomic
// read-modify-write of the agent record (updateSessionAgent): the SW
// step-snapshot handler writes the same record every step, and a separate
// get → set here used to race with it and drop queued messages.

/**
 * Append a PendingInstruction to the session's queue. Seeds a minimal agent
 * record when none exists yet (an instruction queued during the first step of
 * a brand-new session, before the first snapshot) — it used to be dropped.
 */
export async function addPending(
  sessionId: string,
  instruction: PendingInstruction,
): Promise<void> {
  await updateSessionAgent(sessionId, (state) => {
    const base = state ?? emptySessionAgentState();
    return { ...base, pendingInstructions: [...(base.pendingInstructions ?? []), instruction] };
  });
}

/**
 * Remove a PendingInstruction by chatMessageId. Idempotent — missing id is no-op.
 * Returns true if something was removed.
 */
export async function cancelPending(
  sessionId: string,
  chatMessageId: string,
): Promise<boolean> {
  let removed = false;
  await updateSessionAgent(sessionId, (state) => {
    if (!state) return null;
    const pending = state.pendingInstructions ?? [];
    const filtered = pending.filter((p) => p.chatMessageId !== chatMessageId);
    if (filtered.length === pending.length) return null;
    removed = true;
    return { ...state, pendingInstructions: filtered };
  });
  return removed;
}

/**
 * Read + clear queue atomically. Returns the drained instructions in FIFO order.
 * Caller is responsible for broadcasting the empty state and pushing the merged
 * user message into agentMessages.
 */
export async function drainPending(
  sessionId: string,
): Promise<PendingInstruction[]> {
  let drained: PendingInstruction[] = [];
  await updateSessionAgent(sessionId, (state) => {
    const pending = state?.pendingInstructions ?? [];
    if (!state || pending.length === 0) return null;
    drained = pending;
    return { ...state, pendingInstructions: [] };
  });
  return drained;
}

/** Non-destructive peek: does the session have queued instructions? */
export async function hasPending(sessionId: string): Promise<boolean> {
  const state = await getSessionAgent(sessionId);
  return (state?.pendingInstructions?.length ?? 0) > 0;
}
