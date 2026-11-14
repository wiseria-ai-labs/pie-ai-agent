import { describe, it, expect, vi, beforeEach } from "vitest";
import { showSelectionBar, hideBubble, __test__isVisible } from "./floating-bubble";
import type { OverlayUiStrings } from "@/lib/overlay/protocol";

const strings: OverlayUiStrings = {
  barAsk: "Ask Pie",
  barExplain: "Explain",
  barTranslate: "Translate",
  barQuote: "Quote",
  barRewrite: "Rewrite",
  barMore: "More",
  barHideSite: "Don't show on this site",
  capsuleStop: "Stop",
  capsuleExpand: "Open panel",
  capsuleView: "View",
  capsuleRetry: "Retry",
  capsulePanel: "Handle in panel",
  capsuleDone: "Done",
  capsuleStopped: "Stopped",
  capsuleFailed: "Something went wrong",
};

function show(editable: boolean, onAction = vi.fn(), anchorLeft = 200) {
  showSelectionBar({
    anchorTop: 100,
    anchorLeft,
    anchorRight: anchorLeft + 100,
    editable,
    strings,
    onAction,
  });
  return document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
}

function labels(host: HTMLElement): string[] {
  return [...host.shadowRoot!.querySelectorAll("[data-act]")].map(
    (b) => (b as HTMLElement).dataset.act!,
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  hideBubble();
  document.documentElement.querySelectorAll("[data-pie-quote-bubble]").forEach((el) => el.remove());
  Object.defineProperty(window, "innerHeight", { value: 1000, writable: true });
  Object.defineProperty(window, "innerWidth", { value: 1280, writable: true });
});

describe("selection bar", () => {
  it("renders a shadow host", () => {
    const host = show(false);
    expect(host).not.toBeNull();
    expect(host.shadowRoot).not.toBeNull();
  });

  it("read-only selection shows explain / translate / quote — no rewrite", () => {
    const host = show(false);
    expect(labels(host)).toEqual(["ask", "explain", "translate", "quote", "more"]);
  });

  it("editable selection shows ask / rewrite / translate / more — no quote", () => {
    const host = show(true);
    expect(labels(host)).toEqual(["ask", "rewrite", "translate", "more"]);
  });

  it("places the bar above the selection when there is room", () => {
    const host = show(false);
    expect(parseInt(host.style.top, 10)).toBeLessThan(100);
  });

  it("falls back below when the selection is near the top edge", () => {
    showSelectionBar({
      anchorTop: 5,
      anchorLeft: 200,
      anchorRight: 300,
      editable: false,
      strings,
      onAction: vi.fn(),
    });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    expect(parseInt(host.style.top, 10)).toBeGreaterThan(5);
  });

  it("centres over the selection and clamps to the viewport", () => {
    const host = show(false, vi.fn(), 1270);
    const left = parseInt(host.style.left, 10);
    expect(left).toBeLessThanOrEqual(1280 - 8);
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it("clicking a button fires the action and hides the bar", () => {
    const onAction = vi.fn();
    const host = show(true, onAction);
    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="rewrite"]')!.click();
    expect(onAction).toHaveBeenCalledWith("rewrite");
    expect(__test__isVisible()).toBe(false);
  });

  it("⋯ opens a menu whose only item hides the site", () => {
    const onAction = vi.fn();
    const host = show(false, onAction);
    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="more"]')!.click();
    const hide = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="hide-site"]')!;
    expect(hide.textContent).toContain("Don't show");
    hide.click();
    expect(onAction).toHaveBeenCalledWith("hide-site");
  });

  it("hide removes the host", () => {
    show(false);
    hideBubble();
    expect(__test__isVisible()).toBe(false);
  });
});
