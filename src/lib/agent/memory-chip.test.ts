import { describe, it, expect, vi } from "vitest";
import { wrapEmitWithMemoryChip } from "./memory-chip";
import type { PortMessageToPanel } from "@/types";

const chip: PortMessageToPanel = {
  type: "memory-used",
  sessionId: "S1",
  items: [{ id: "m_1", title: "住在杭州" }],
};

describe("memory chip placement", () => {
  it("emits the chip once, immediately before the terminal event", () => {
    const seen: string[] = [];
    const emit = wrapEmitWithMemoryChip((m) => seen.push(m.type), chip);

    emit({ type: "chat-chunk", sessionId: "S1", text: "答" });
    emit({ type: "chat-done", sessionId: "S1" });

    expect(seen).toEqual(["chat-chunk", "memory-used", "chat-done"]);
  });

  it("never emits the chip twice or after the terminal event", () => {
    const sent: PortMessageToPanel[] = [];
    const emit = wrapEmitWithMemoryChip((m) => sent.push(m), chip);
    emit({ type: "agent-done-task", sessionId: "S1", success: true, summary: "", stepCount: 1 });
    emit({ type: "chat-done", sessionId: "S1" });
    expect(sent.filter((m) => m.type === "memory-used")).toHaveLength(1);
  });

  it("is a pass-through when no chip was picked", () => {
    const inner = vi.fn();
    const emit = wrapEmitWithMemoryChip(inner, null);
    emit({ type: "chat-done", sessionId: "S1" });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
