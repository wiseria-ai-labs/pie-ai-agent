import { describe, expect, it } from "vitest";
import { pageOperationTarget } from "./page-operation";

describe("page operation targets", () => {
  it("resolves the element a mouse/DOM tool will hit", () => {
    expect(pageOperationTarget("click", { frameId: 0, elementIndex: 12 })).toEqual({
      frameId: 0,
      elementIndex: 12,
    });
    expect(pageOperationTarget("type", { frameId: "3", elementIndex: "7" })).toEqual({
      frameId: 3,
      elementIndex: 7,
    });
    expect(pageOperationTarget("set_editor_value", { elementIndex: 4 })).toEqual({
      frameId: 0,
      elementIndex: 4,
    });
  });

  it("keyboard goes to the focused element unless the tool clicks one first", () => {
    expect(pageOperationTarget("press_key", { key: "Enter" })).toEqual({ activeElement: true });
    expect(pageOperationTarget("dispatch_keyboard_input", { text: "hi" })).toEqual({
      activeElement: true,
    });
    expect(
      pageOperationTarget("dispatch_keyboard_input", { text: "hi", after_element_index: 9 }),
    ).toEqual({ frameId: 0, elementIndex: 9 });
  });

  it("whole-page scroll has no spatial target (never hides the overlay)", () => {
    expect(pageOperationTarget("scroll", { direction: "down" })).toEqual({ viewport: true });
  });
});
