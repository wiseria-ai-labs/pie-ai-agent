// The agent loop pauses a task (instead of failing it) when every retry of an
// LLM request failed. These helpers own the session-meta side of that pause.

import { updateSessionMeta } from "@/lib/sessions/storage";
import type { SessionAgentState, SessionMeta } from "@/lib/sessions/types";

/**
 * Mark the session paused and record why, so the panel shows the error with a
 * Retry button. Only an `active` session is paused — if the user already moved
 * it elsewhere (archived, deleted) the write is skipped.
 */
export async function pauseSessionForLlmError(sessionId: string, error: string): Promise<void> {
  await updateSessionMeta(sessionId, (current) =>
    current.status === "active"
      ? { ...current, status: "paused", pauseReason: { kind: "llm-error", error, at: Date.now() } }
      : null,
  );
}

/** Back to `active`, dropping any LLM-pause reason. */
export function clearLlmPause(meta: SessionMeta): SessionMeta {
  const { pauseReason: _drop, ...rest } = meta;
  return { ...rest, status: "active" };
}

/**
 * Is there a task to resume? Normally a step must have completed
 * (stepIndex > 0). An LLM-error pause on the very first step has stepIndex 0
 * but a real seed ([system, user(task + observation)]), so it qualifies too.
 */
export function hasResumableAgentState(
  meta: Pick<SessionMeta, "pauseReason">,
  agent: SessionAgentState | null | undefined,
): agent is SessionAgentState {
  if (!agent) return false;
  if (agent.stepIndex > 0) return true;
  return !!meta.pauseReason && agent.agentMessages.length > 0;
}
