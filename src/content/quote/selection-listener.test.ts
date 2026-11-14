import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachSelectionListener, detachSelectionListener } from "./selection-listener";
import { hideBubble } from "./floating-bubble";
import { setOverlayConfig } from "@/content/overlay/config";

const sendMessageMock = vi.fn();

const STRINGS = {
  barAsk: "Ask Pie",
  activityReadPage: "Reading the page",
  activityActPage: "Working on the page",
  activityOpenPage: "Opening a page",
  activityReadPdf: "Reading the PDF",
  activitySearchBookmarks: "Searching bookmarks",
  activitySearchHistory: "Searching history",
  activityBookmarks: "Updating bookmarks",
  activityMemory: "Updating memory",
  activityMonitor: "Setting up a monitor",
  activityOther: "Working…",
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

beforeEach(() => {
  vi.useFakeTimers();
  sendMessageMock.mockReset();
  document.body.innerHTML = "<p id='p'>Hello world</p>";
  // @ts-expect-error mock
  globalThis.chrome = { runtime: { sendMessage: sendMessageMock } };
  // @ts-expect-error
  globalThis.location = { href: "https://example.com/page", host: "example.com" };
  setOverlayConfig({
    settings: { barEnabled: true, excludedHosts: [], position: "anchor" },
    strings: STRINGS,
  });
});

afterEach(() => {
  vi.useRealTimers();
  detachSelectionListener();
  window.getSelection()?.removeAllRanges();
  setOverlayConfig(null);
});

function selectRange(start: number, end: number) {
  const p = document.getElementById("p")!;
  const range = document.createRange();
  range.setStart(p.firstChild!, start);
  range.setEnd(p.firstChild!, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  vi.spyOn(range, "getBoundingClientRect").mockReturnValue({
    top: 100, left: 50, right: 150, bottom: 120, x: 50, y: 100, width: 100, height: 20,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(range, "getClientRects").mockReturnValue([
    {
      top: 100, left: 50, right: 150, bottom: 120, x: 50, y: 100, width: 100, height: 20,
      toJSON: () => ({}),
    } as DOMRect,
  ] as unknown as DOMRectList);
}

function host(): HTMLElement | null {
  return document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]");
}

describe("selection listener", () => {
  it("non-empty selection on mouseup → shows the bar after setTimeout", () => {
    attachSelectionListener();
    selectRange(0, 5);
    hideBubble();
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(host()).toBeNull();
    vi.runAllTimers();
    expect(host()).not.toBeNull();
  });

  it("empty selection → no bar (even after timers)", () => {
    attachSelectionListener();
    window.dispatchEvent(new MouseEvent("mouseup"));
    vi.runAllTimers();
    expect(host()).toBeNull();
  });

  it("read-only selection offers quote, and clicking it emits quote-text-captured", () => {
    attachSelectionListener();
    selectRange(0, 5);
    const btn = host()!.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="quote"]')!;
    btn.click();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "quote-text-captured",
      payload: { text: "Hello", sourceUrl: "https://example.com/page" },
    });
  });

  it("'ask' emits an overlay intent with the selection, not a quote", () => {
    attachSelectionListener();
    selectRange(0, 5);
    host()!.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="ask"]')!.click();
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "overlay:intent",
        intent: "ask",
        host: "example.com",
        selection: expect.objectContaining({ text: "Hello", editable: false }),
      }),
    );
  });

  it("'hide-site' excludes the host instead of opening anything", () => {
    attachSelectionListener();
    selectRange(0, 5);
    host()!.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="more"]')!.click();
    host()!.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="hide-site"]')!.click();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "overlay:exclude-site",
      host: "example.com",
    });
  });

  it("no bar when the site is excluded", () => {
    setOverlayConfig({
      settings: { barEnabled: true, excludedHosts: ["example.com"], position: "anchor" },
      strings: STRINGS,
    });
    attachSelectionListener();
    selectRange(0, 5);
    expect(host()).toBeNull();
  });

  it("no bar when the feature is switched off", () => {
    setOverlayConfig({
      settings: { barEnabled: false, excludedHosts: [], position: "anchor" },
      strings: STRINGS,
    });
    attachSelectionListener();
    selectRange(0, 5);
    expect(host()).toBeNull();
  });

  it("selection cleared via selectionchange → bar hides", () => {
    attachSelectionListener();
    selectRange(0, 5);
    expect(host()).not.toBeNull();
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(host()).toBeNull();
  });

  it("detach removes listeners (no bar after detach)", () => {
    attachSelectionListener();
    detachSelectionListener();
    selectRange(0, 5);
    expect(host()).toBeNull();
  });

  it("cross-instance attach cleans up stale window handlers (simulates SW reinject)", () => {
    const staleMouseUp = vi.fn();
    const staleSelectionChange = vi.fn();
    window.addEventListener("mouseup", staleMouseUp);
    document.addEventListener("selectionchange", staleSelectionChange);
    (window as unknown as { __pieQuoteHandlers?: { mouseup: EventListener; selectionchange: EventListener } })
      .__pieQuoteHandlers = { mouseup: staleMouseUp, selectionchange: staleSelectionChange };

    attachSelectionListener();
    window.dispatchEvent(new MouseEvent("mouseup"));
    document.dispatchEvent(new Event("selectionchange"));

    expect(staleMouseUp).not.toHaveBeenCalled();
    expect(staleSelectionChange).not.toHaveBeenCalled();
  });
});
