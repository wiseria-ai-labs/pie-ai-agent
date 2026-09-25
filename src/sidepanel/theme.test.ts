import { describe, it, expect } from "vitest";
import { parseUiScale } from "./theme";

describe("parseUiScale", () => {
  it("keeps in-range values, falls back to 1 for anything else", () => {
    expect(parseUiScale("1.25")).toBe(1.25);
    expect(parseUiScale(0.7)).toBe(0.7);
    expect(parseUiScale(1.5)).toBe(1.5);
    for (const bad of [null, undefined, "", "abc", "0.5", 2, NaN, true, [1.2]]) {
      expect(parseUiScale(bad)).toBe(1);
    }
  });
});
