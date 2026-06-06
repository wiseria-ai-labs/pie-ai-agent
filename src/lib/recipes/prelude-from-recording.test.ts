import { describe, it, expect } from "vitest";
import { recordingToPrelude } from "./prelude-from-recording";
import type { RecordedAction } from "../recording/types";

// Helper to build a minimal RecordedAction
function makeAction(overrides: Partial<RecordedAction> & Pick<RecordedAction, "type">): RecordedAction {
  return {
    label: "元素",
    url: "https://example.com",
    region: "main",
    timestamp: 1000,
    ...overrides,
  };
}

describe("recordingToPrelude", () => {
  it("click with selectorHint and quoted label text → locator has class + text signals", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "click",
        label: "按钮 'Submit'",
        selectorHint: "[data-testid=submit-btn]",
      }),
    ];
    const steps = recordingToPrelude(actions);
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.type).toBe("click");
    expect(step.locator).toBeDefined();
    const signals = step.locator!.signals;
    // class signal from selectorHint (first)
    const classSignal = signals.find((s) => s.kind === "class");
    expect(classSignal).toBeDefined();
    expect(classSignal!.value).toBe("[data-testid=submit-btn]");
    expect(classSignal!.stable).toBe(true); // unstable is undefined → !undefined → stable
    // text signal from quoted label text (second)
    const textSignal = signals.find((s) => s.kind === "text");
    expect(textSignal).toBeDefined();
    expect(textSignal!.value).toBe("Submit");
    expect(textSignal!.stable).toBe(false);
  });

  it("click marked unstable → class signal stable=false", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "click",
        label: "링크 'Next'",
        selectorHint: ".link-next",
        unstable: true,
      }),
    ];
    const steps = recordingToPrelude(actions);
    const classSignal = steps[0].locator!.signals.find((s) => s.kind === "class");
    expect(classSignal!.stable).toBe(false);
  });

  it("type action preserves value", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "type",
        label: "输入框 'Email'",
        selectorHint: "[name=email]",
        value: "user@example.com",
      }),
    ];
    const steps = recordingToPrelude(actions);
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe("type");
    expect(steps[0].value).toBe("user@example.com");
    expect(steps[0].locator).toBeDefined();
  });

  it("navigate action → step with type=navigate and url from action, no locator", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "navigate",
        label: "导航",
        url: "https://example.com/login",
      }),
    ];
    const steps = recordingToPrelude(actions);
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe("navigate");
    expect(steps[0].url).toBe("https://example.com/login");
    // navigate steps don't get a locator
    expect(steps[0].locator).toBeUndefined();
  });

  it("scroll and keypress actions are skipped", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "scroll", label: "scroll" }),
      makeAction({ type: "keypress", label: "keypress" }),
      makeAction({ type: "click", label: "按钮 'OK'", selectorHint: "#ok" }),
    ];
    const steps = recordingToPrelude(actions);
    // Only the click survives
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe("click");
  });

  it("select action is included with value", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "select",
        label: "드롭다운",
        selectorHint: "select#region",
        value: "us-west",
      }),
    ];
    const steps = recordingToPrelude(actions);
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe("select");
    expect(steps[0].value).toBe("us-west");
  });

  it("submit action is included", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "submit", label: "フォーム", selectorHint: "form#login" }),
    ];
    const steps = recordingToPrelude(actions);
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe("submit");
  });

  it("action without selectorHint → class signal absent, only text if label has quotes", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "click", label: "按钮 'OK'" }),
    ];
    const steps = recordingToPrelude(actions);
    const signals = steps[0].locator!.signals;
    const classSignals = signals.filter((s) => s.kind === "class");
    expect(classSignals).toHaveLength(0);
    const textSignal = signals.find((s) => s.kind === "text");
    expect(textSignal!.value).toBe("OK");
  });

  it("action without quoted text in label → only class signal", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "click", label: "导航区第 3 个链接", selectorHint: "nav a:nth-child(3)" }),
    ];
    const steps = recordingToPrelude(actions);
    const signals = steps[0].locator!.signals;
    const textSignals = signals.filter((s) => s.kind === "text");
    expect(textSignals).toHaveLength(0);
    const classSignal = signals.find((s) => s.kind === "class");
    expect(classSignal!.value).toBe("nav a:nth-child(3)");
  });

  it("empty actions array returns empty steps", () => {
    expect(recordingToPrelude([])).toHaveLength(0);
  });

  it("mixed actions are converted in order", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "navigate", label: "nav", url: "https://example.com/login" }),
      makeAction({ type: "type", label: "输入 'email'", selectorHint: "[name=email]", value: "a@b.com" }),
      makeAction({ type: "scroll", label: "scroll" }),
      makeAction({ type: "click", label: "按钮 'Login'", selectorHint: "#login-btn" }),
    ];
    const steps = recordingToPrelude(actions);
    // scroll is skipped → 3 steps
    expect(steps).toHaveLength(3);
    expect(steps[0].type).toBe("navigate");
    expect(steps[1].type).toBe("type");
    expect(steps[2].type).toBe("click");
  });
});
