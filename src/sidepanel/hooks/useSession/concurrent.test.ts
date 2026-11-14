import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSession } from "./index";
import { chromeMock } from "@/test/setup";
import { getSessionMeta } from "@/lib/sessions/storage";

describe("useSession concurrent (#30) — Case 1: chat-chunk routing", () => {
  it("routes chat-chunk to the addressed session's slot only", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = chromeMock.runtime.__ports.at(-1)!;

    // Start a task on A so streaming=true (chunks only arrive during streaming)
    await act(async () => {
      result.current.sendMessage({ content: "hello from A" });
    });
    expect(result.current.streaming).toBe(true);

    // Switch to a new session B (A is now backgrounded and streaming)
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    expect(result.current.sessionId).toBe(idB);

    // Background chunk to A while B is active
    act(() => {
      portA.__emit({ type: "chat-chunk", text: "from-A", sessionId: idA } as never);
    });
    // Active session view is B — streamingText should be unchanged
    expect(result.current.streamingText).toBe("");

    // Switch back to A (streaming=true, slot preserved) — the chunk should be visible
    await act(async () => {
      await result.current.setActive(idA);
    });
    expect(result.current.streamingText).toBe("from-A");
  });
});

describe("useSession concurrent (#30) — Case 2: background done", () => {
  it("agent-done-task on backgrounded A is visible after switching back", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = chromeMock.runtime.__ports.at(-1)!;
    // Start a fake task on A
    await act(async () => {
      result.current.sendMessage({ content: "hi" });
    });
    expect(result.current.streaming).toBe(true);
    // Switch to a new session B
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    expect(result.current.sessionId).toBe(idB);
    // SW emits done for A (background)
    act(() => {
      portA.__emit({
        type: "agent-done-task",
        sessionId: idA,
        success: true,
        summary: "done",
        stepCount: 2,
      } as never);
    });
    expect(result.current.streaming).toBe(false); // B is not streaming
    // Wait for async persist to land in storage before setActive re-hydrates
    await waitFor(async () => {
      const meta = await getSessionMeta(idA);
      expect(meta?.messages.at(-1)).toMatchObject({ role: "agent-summary" });
    });
    // Switch back to A — see the summary
    await act(async () => {
      await result.current.setActive(idA);
    });
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last).toMatchObject({ role: "agent-summary", success: true, summary: "done" });
  });
});

describe("useSession concurrent (#30) — Case 5: Stop scoped to active", () => {
  it("abort() posts chat-abort on active port only", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const portA = chromeMock.runtime.__ports.at(-1)!;
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = chromeMock.runtime.__ports.at(-1)!;

    // Send a message on B (active session)
    await act(async () => {
      result.current.sendMessage({ content: "in B" });
    });

    // Stop while B is active
    act(() => {
      result.current.abort();
    });
    expect(portB.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat-abort" }),
    );
    expect(portA.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat-abort" }),
    );
  });
});
