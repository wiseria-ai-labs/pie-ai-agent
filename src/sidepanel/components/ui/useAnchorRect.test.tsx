import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import { useAnchorRect, viewportSize } from "./useAnchorRect";
import { applyUiScale } from "@/sidepanel/theme";
import { computePopoverCoords } from "../ModelPicker";

afterEach(() => {
  cleanup();
  applyUiScale(1);
});

const fakeRect = (over: Partial<DOMRect> = {}): DOMRect =>
  ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...over,
  }) as DOMRect;

function Harness({ open, onRect }: { open: boolean; onRect: (r: DOMRect | null) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const rect = useAnchorRect(ref, open);
  onRect(rect);
  return <button ref={ref}>anchor</button>;
}

describe("useAnchorRect", () => {
  it("returns null when closed", () => {
    let last: DOMRect | null = fakeRect();
    render(<Harness open={false} onRect={(r) => (last = r)} />);
    expect(last).toBeNull();
  });

  it("measures the anchor rect when open", () => {
    let last: DOMRect | null = null;
    const spy = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockReturnValue(fakeRect({ left: 5, top: 10, bottom: 30, width: 100 }));
    render(<Harness open={true} onRect={(r) => (last = r)} />);
    expect(last).not.toBeNull();
    expect(last!.left).toBe(5);
    expect(last!.width).toBe(100);
    spy.mockRestore();
  });

  it("re-measures on window resize while open", () => {
    let calls = 0;
    const spy = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => {
        calls++;
        return fakeRect();
      });
    render(<Harness open={true} onRect={() => {}} />);
    const initial = calls;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(calls).toBeGreaterThan(initial);
    spy.mockRestore();
  });

  // Interface scale (#455): <html> zoom makes getBoundingClientRect / innerWidth
  // visual px while fixed top/left get multiplied by the zoom — the hook and
  // viewportSize() both hand back zoomed-space values so coords land on the anchor.
  it("divides the rect and the viewport by the root zoom", () => {
    applyUiScale(1.5);
    const spy = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockReturnValue(fakeRect({ left: 60, top: 150, bottom: 180, right: 210, width: 150, height: 30 }));
    let last: DOMRect | null = null;
    render(<Harness open={true} onRect={(r) => (last = r)} />);
    expect(last!.left).toBeCloseTo(40);
    expect(last!.top).toBeCloseTo(100);
    expect(last!.bottom).toBeCloseTo(120);
    expect(last!.width).toBeCloseTo(100);

    const vp = viewportSize();
    expect(vp.w).toBeCloseTo(window.innerWidth / 1.5);
    expect(vp.h).toBeCloseTo(window.innerHeight / 1.5);
    // Opens downward right under the anchor (zoomed px), not 1.5× further down.
    expect(computePopoverCoords(last!, 400, 400)).toEqual({ left: 40, top: 128 });
    spy.mockRestore();
  });

  it("zoom 1 leaves the rect untouched", () => {
    applyUiScale(1);
    expect(document.documentElement.style.zoom).toBe("");
    expect(viewportSize()).toEqual({ w: window.innerWidth, h: window.innerHeight });
  });
});
