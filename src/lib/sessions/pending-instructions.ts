import type { PendingInstruction } from "./types";
import { emptySessionAgent, getSessionAgent, updateSessionAgent } from "./storage";

// Issue #470 — every queue op is a single-transaction read-modify-write
// (updateSessionAgent) so a concurrent step-snapshot / confirm / usage write
// can never write back a stale queue.

/**
 * Append a PendingInstruction to the session's queue. Seeds a minimal agent
 * record when none exists yet (brand-new session before its first step
 * snapshot) — the first snapshot's non-tombstone merge keeps the queue.
 */
export async function addPending(
  sessionId: string,
  instruction: PendingInstruction,
): Promise<void> {
  await updateSessionAgent(sessionId, (state) => {
    const base = state ?? emptySessionAgent();
    return {
      ...base,
      pendingInstructions: [...(base.pendingInstructions ?? []), instruction],
    };
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
  return updateSessionAgent(sessionId, (state) => {
    const queue = state?.pendingInstructions ?? [];
    const filtered = queue.filter((p) => p.chatMessageId !== chatMessageId);
    if (!state || filtered.length === queue.length) return null;
    return { ...state, pendingInstructions: filtered };
  });
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
    drained = state?.pendingInstructions ?? [];
    if (!state || drained.length === 0) return null;
    return { ...state, pendingInstructions: [] };
  });
  return drained;
}

/** Non-destructive peek: does the session have queued instructions? */
export async function hasPending(sessionId: string): Promise<boolean> {
  return ((await getSessionAgent(sessionId))?.pendingInstructions?.length ?? 0) > 0;
}
