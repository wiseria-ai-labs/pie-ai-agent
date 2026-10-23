import { describe, it, expect } from "vitest";
import { clearLlmPause, hasResumableAgentState, pauseSessionForLlmError, pauseSessionWithReason } from "./llm-pause";
import { createSession, getSessionMeta, updateSessionMeta } from "@/lib/sessions/storage";
import type { SessionAgentState } from "@/lib/sessions/types";

const agent = (stepIndex: number, n: number) =>
  ({ agentMessages: Array.from({ length: n }, () => ({ role: "user", content: "x" })), stepIndex, pendingInstructions: [], hasImageContent: false }) as SessionAgentState;

describe("pauseSessionForLlmError", () => {
  it("pauses an active session and records the error", async () => {
    const meta = await createSession();
    await pauseSessionForLlmError(meta.id, "HTTP 503");
    const after = await getSessionMeta(meta.id);
    expect(after?.status).toBe("paused");
    expect(after?.pauseReason).toMatchObject({ kind: "llm-error", error: "HTTP 503" });
  });

  it("leaves a session that is no longer active alone", async () => {
    const meta = await createSession();
    await updateSessionMeta(meta.id, (m) => ({ ...m, status: "archived" }));
    await pauseSessionForLlmError(meta.id, "HTTP 503");
    const after = await getSessionMeta(meta.id);
    expect(after?.status).toBe("archived");
    expect(after?.pauseReason).toBeUndefined();
  });

  it("clearLlmPause flips back to active and drops the reason", async () => {
    const meta = await createSession();
    await pauseSessionForLlmError(meta.id, "x");
    const cleared = clearLlmPause((await getSessionMeta(meta.id))!);
    expect(cleared.status).toBe("active");
    expect("pauseReason" in cleared).toBe(false);
  });
});

describe("pauseSessionWithReason", () => {
  it("records a tab-closed pause", async () => {
    const meta = await createSession();
    await pauseSessionWithReason(meta.id, "tab-closed", "The tab this task was working in (tab 5) was closed.");
    const after = await getSessionMeta(meta.id);
    expect(after?.status).toBe("paused");
    expect(after?.pauseReason).toMatchObject({ kind: "tab-closed" });
  });
});

describe("hasResumableAgentState", () => {
  const llmPause = { pauseReason: { kind: "llm-error" as const, error: "e", at: 1 } };
  it("any completed step is resumable", () => {
    expect(hasResumableAgentState({}, agent(3, 5))).toBe(true);
  });
  it("a first-step LLM pause (stepIndex 0, real seed) is resumable", () => {
    expect(hasResumableAgentState(llmPause, agent(0, 2))).toBe(true);
  });
  it("a tombstone is not, with or without a pause reason", () => {
    expect(hasResumableAgentState({}, agent(0, 0))).toBe(false);
    expect(hasResumableAgentState(llmPause, agent(0, 0))).toBe(false);
    expect(hasResumableAgentState({}, agent(0, 2))).toBe(false); // SW-restart pause rule unchanged
    expect(hasResumableAgentState(llmPause, null)).toBe(false);
  });
});
