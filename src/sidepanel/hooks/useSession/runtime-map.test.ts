import { describe, it, expect } from "vitest";
import { EMPTY_SLOT, releaseImageBytes, withSlot } from "./runtime-map";
import type { DisplayMessage, Quote } from "@/types";

describe("SessionRuntimeSlot quotes field", () => {
  it("EMPTY_SLOT.quotes defaults to empty array", () => {
    expect(EMPTY_SLOT.quotes).toEqual([]);
  });

  it("withSlot can append a quote", () => {
    const q: Quote = { id: "1", kind: "text", text: "x", sourceUrl: "u", sourceTabId: 1 };
    const prev = new Map();
    const next = withSlot(prev, "S1", (s) => ({ quotes: [...s.quotes, q] }));
    expect(next.get("S1")!.quotes).toEqual([q]);
  });

  it("withSlot can clear quotes (set to [])", () => {
    const q: Quote = { id: "1", kind: "text", text: "x", sourceUrl: "u", sourceTabId: 1 };
    const seeded = withSlot(new Map(), "S1", { quotes: [q] });
    const cleared = withSlot(seeded, "S1", { quotes: [] });
    expect(cleared.get("S1")!.quotes).toEqual([]);
  });
});

describe("#438 releaseImageBytes", () => {
  const stepWithImage: DisplayMessage = {
    role: "agent-step",
    stepIndex: 0,
    tool: "capture_visible_tab",
    args: {},
    status: "ok",
    image: { mediaType: "image/jpeg", data: "BASE64", width: 100, height: 50 },
  };

  it("drops screenshot bytes but keeps the step + dimensions", () => {
    const out = releaseImageBytes([stepWithImage]);
    const image = (out[0] as Extract<DisplayMessage, { role: "agent-step" }>).image!;
    expect(image.data).toBeUndefined();
    expect(image.mediaType).toBe("image/jpeg");
    expect(image.width).toBe(100);
    expect(out[0]!.role).toBe("agent-step");
  });

  it("returns the same array when there is nothing to release (no re-render)", () => {
    const plain: DisplayMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "agent-step", stepIndex: 1, tool: "click", args: {}, status: "ok" },
    ];
    expect(releaseImageBytes(plain)).toBe(plain);
  });
});
