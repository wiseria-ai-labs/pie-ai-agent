import { describe, it, expect } from "vitest";
import { isNearBottom, NEAR_BOTTOM_PX } from "./chat-scroll";

function box(scrollTop: number, scrollHeight = 2000, clientHeight = 400) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("isNearBottom", () => {
  it("treats the exact threshold as at-bottom", () => {
    // distance = 60
    expect(isNearBottom(box(2000 - 400 - NEAR_BOTTOM_PX))).toBe(true);
  });

  it("treats one pixel past the threshold as away", () => {
    expect(isNearBottom(box(2000 - 400 - NEAR_BOTTOM_PX - 1))).toBe(false);
  });

  it("treats the true tail as at-bottom", () => {
    expect(isNearBottom(box(1600))).toBe(true); // 2000-1600-400 = 0
  });

  it("treats a mid-list position as away (wheel / trackpad / drag / touch all feed this)", () => {
    expect(isNearBottom(box(0))).toBe(false);
    expect(isNearBottom(box(200))).toBe(false);
  });
});
