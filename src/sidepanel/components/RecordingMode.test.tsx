/**
 * RecordingMode — F1 (G3 motion-budget regression).
 *
 * The Vital Bar (top) and the Footer Recording Bar (bottom) both render a
 * VailieMark `recording` instance. G3 caps animated VailieMark instances at
 * ≤2 on screen at once; RecordingMode is a single-screen view, so it must
 * keep at most ONE of its two marks animated — the Footer Bar's duplicate is
 * decorative and must pass `animate={false}` (adds the `vailie-mark--static`
 * class, see VailieMark.tsx).
 */
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import RecordingMode from "./RecordingMode";
import type { RecordedAction } from "@/lib/recording/types";

const ACTIONS: RecordedAction[] = [
  {
    type: "click",
    label: "按钮 'Submit'",
    url: "https://example.com",
    region: "main",
    timestamp: 1,
  },
];

describe("RecordingMode — F1 G3 motion budget", () => {
  it("renders exactly one animated .vailie-mark instance (Vital Bar); the Footer Bar duplicate is static", () => {
    const { container } = render(
      <RecordingMode
        active
        actions={ACTIONS}
        lastAbortReason={null}
        onFinish={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    const marks = Array.from(container.querySelectorAll(".vailie-mark"));
    expect(marks.length).toBeGreaterThanOrEqual(2); // Vital Bar + Footer Bar
    const animated = marks.filter((el) => !el.className.includes("vailie-mark--static"));
    expect(animated.length).toBe(1);
  });
});
