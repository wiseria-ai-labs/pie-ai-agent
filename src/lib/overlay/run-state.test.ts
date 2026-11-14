import { describe, it, expect } from "vitest";
import {
  applyOverlayEmit,
  capsuleSteps,
  createOverlayRun,
  currentStepLabel,
  detachedMessagesToPersist,
  isTerminalEmit,
  isWriteStep,
  markStopped,
  stepLabel,
  summarizeToolArgs,
} from "./run-state";
import type { PortMessageToPanel } from "@/types";

const SID = "s1";

function step(over: Partial<Extract<PortMessageToPanel, { type: "agent-step" }>> = {}): PortMessageToPanel {
  return {
    type: "agent-step",
    stepIndex: 1,
    tool: "click",
    args: { label: "发送" },
    status: "pending",
    sessionId: SID,
    ...over,
  } as PortMessageToPanel;
}

describe("overlay run state", () => {
  it("accumulates streamed text and flushes it on chat-done", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "chat-chunk", text: "Hel", sessionId: SID } as PortMessageToPanel);
    run = applyOverlayEmit(run, { type: "chat-chunk", text: "lo", sessionId: SID } as PortMessageToPanel);
    expect(run.accumulated).toBe("Hello");
    run = applyOverlayEmit(run, { type: "chat-done", sessionId: SID } as PortMessageToPanel);
    expect(run.status).toBe("done");
    expect(run.accumulated).toBe("");
    expect(run.pending).toEqual([{ role: "assistant", content: "Hello" }]);
  });

  it("flushes text before a step so the transcript order matches the panel", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "chat-chunk", text: "Let me click that.", sessionId: SID } as PortMessageToPanel);
    run = applyOverlayEmit(run, step());
    expect(run.pending.map((m) => m.role)).toEqual(["assistant", "agent-step"]);
    expect(run.steps).toHaveLength(1);
  });

  it("records the focused tab from steps (capsule follows the agent)", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, step({ focusTabId: 42 }));
    expect(run.tabId).toBe(42);
  });

  it("agent-done-task marks success/failure and appends the summary", () => {
    let ok = createOverlayRun(SID, 7);
    ok = applyOverlayEmit(ok, {
      type: "agent-done-task",
      success: true,
      summary: "已发送",
      stepCount: 2,
      sessionId: SID,
    } as PortMessageToPanel);
    expect(ok.status).toBe("done");
    expect(ok.pending.at(-1)).toMatchObject({ role: "agent-summary", success: true });

    let bad = createOverlayRun(SID, 7);
    bad = applyOverlayEmit(bad, {
      type: "agent-done-task",
      success: false,
      summary: "被挡住",
      stepCount: 1,
      sessionId: SID,
    } as PortMessageToPanel);
    expect(bad.status).toBe("failed");
  });

  it("chat-error becomes a failed run without inventing an assistant message", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "chat-error", error: "boom", sessionId: SID } as PortMessageToPanel);
    expect(run.status).toBe("failed");
    expect(run.doneLabel).toBe("boom");
    expect(run.pending).toEqual([]);
  });

  it("terminal emits are recognised", () => {
    expect(isTerminalEmit({ type: "chat-done", sessionId: SID } as PortMessageToPanel)).toBe(true);
    expect(
      isTerminalEmit({
        type: "agent-done-task",
        success: true,
        summary: "",
        stepCount: 1,
        sessionId: SID,
      } as PortMessageToPanel),
    ).toBe(true);
    expect(isTerminalEmit({ type: "chat-chunk", text: "x", sessionId: SID } as PortMessageToPanel)).toBe(false);
  });

  it("markStopped keeps the already streamed text and only changes a running run", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "chat-chunk", text: "partial", sessionId: SID } as PortMessageToPanel);
    const stopped = markStopped(run);
    expect(stopped.status).toBe("stopped");
    expect(stopped.pending).toEqual([{ role: "assistant", content: "partial" }]);
    // A finished run is not "stopped" retroactively.
    const done = applyOverlayEmit(stopped, { type: "chat-done", sessionId: SID } as PortMessageToPanel);
    expect(markStopped(done).status).toBe("done");
  });

  it("persists only when the document is detached (no double writes)", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "chat-chunk", text: "hi", sessionId: SID } as PortMessageToPanel);
    run = applyOverlayEmit(run, { type: "chat-done", sessionId: SID } as PortMessageToPanel);
    expect(detachedMessagesToPersist(run)).toEqual([]); // document alive → it persists
    expect(detachedMessagesToPersist({ ...run, detached: true })).toHaveLength(1);
  });

  it("keeps the memory chip under the answer (flush, then append)", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "chat-chunk", text: "回答", sessionId: SID } as PortMessageToPanel);
    run = applyOverlayEmit(run, {
      type: "memory-used",
      sessionId: SID,
      items: [{ id: "m_1", title: "住在杭州" }],
    } as PortMessageToPanel);
    run = applyOverlayEmit(run, { type: "chat-done", sessionId: SID } as PortMessageToPanel);
    expect(run.pending.map((m) => m.role)).toEqual(["assistant", "memory-used"]);
  });

  it("drops an empty memory chip", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, { type: "memory-used", sessionId: SID, items: [] } as PortMessageToPanel);
    expect(run.pending).toHaveLength(0);
  });

  it("capsule lists steps with consecutive duplicates collapsed", () => {
    let run = createOverlayRun(SID, 7);
    run = applyOverlayEmit(run, step({ stepIndex: 1 }));
    run = applyOverlayEmit(run, step({ stepIndex: 2 }));
    run = applyOverlayEmit(run, step({ stepIndex: 3, tool: "type", args: { text: "hi" } }));
    expect(capsuleSteps(run)).toEqual(["click · 发送", "type · hi"]);
    expect(currentStepLabel(run)).toBe("type · hi");
  });

  it("classifies write tools (capsule collapse trigger) via the shared registry", () => {
    expect(isWriteStep("click")).toBe(true);
    expect(isWriteStep("type")).toBe(true);
    expect(isWriteStep("read_page")).toBe(false);
    expect(isWriteStep("propose_rewrite")).toBe(false);
  });

  it("summarizeToolArgs prefers a human field and bounds the length", () => {
    expect(summarizeToolArgs({ selector: "#a", label: "发送" })).toBe("发送");
    expect(summarizeToolArgs({})).toBe("");
    expect(summarizeToolArgs(null)).toBe("");
    const long = summarizeToolArgs({ text: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
    expect(stepLabel("click", { label: "发送" })).toBe("click · 发送");
    expect(stepLabel("wait", undefined)).toBe("wait");
  });
});
