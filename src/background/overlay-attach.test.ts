// SW-level handoff: a task started by the overlay document (whose document is
// gone) keeps streaming into a side-panel port that attaches afterwards.
//
// The pure replay rule lives in run-fanout.test.ts; this suite pins that the
// run registry wires it up the way the SW does: attach mid-run, live continue,
// terminal event delivered, and no duplicate persistence by the SW while the
// panel owns the write.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PortMessageToPanel } from "@/types";
import {
  attachPanelToRun,
  detachOverlayRun,
  detachPanelFromRun,
  ensurePanelForOverlayRequest,
  isOverlayRunLive,
  startOverlayRun,
  wrapOverlayEmit,
} from "./overlay";
import { openPanel } from "./panel-open";

// The panel open path itself has its own suite (panel-open.test.ts); here we
// only pin that the HITL fallback asks for it.
vi.mock("./panel-open", () => ({ openPanel: vi.fn() }));

vi.stubGlobal("chrome", {
  runtime: {
    getPlatformInfo: vi.fn(async () => ({})),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  tabs: { sendMessage: vi.fn(async () => undefined) },
  storage: { session: { set: vi.fn(async () => undefined) } },
});

function fakePort(): { postMessage: ReturnType<typeof vi.fn> } {
  return { postMessage: vi.fn() };
}

const chunk = (sessionId: string, text: string): PortMessageToPanel => ({
  type: "chat-chunk",
  sessionId,
  text,
});

const done = (sessionId: string): PortMessageToPanel => ({
  type: "chat-done",
  sessionId,
});

describe("overlay run → side panel attach (detached run keeps streaming)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches post-detach, replays, and keeps delivering live events", async () => {
    const sid = "attach-1";
    const overlayPort = fakePort();
    const runtime = startOverlayRun(
      sid,
      7,
      overlayPort as unknown as chrome.runtime.Port,
      new AbortController(),
    );
    const emit = wrapOverlayEmit(runtime, () => {});

    emit(chunk(sid, "早先的一段"));
    // Document dies (navigation / closed overlay) — the task keeps going.
    detachOverlayRun(sid);
    expect(isOverlayRunLive(sid)).toBe(true);

    // Side panel opens the same session and connects its port.
    const panel = fakePort();
    expect(attachPanelToRun(sid, panel as unknown as chrome.runtime.Port)).toBe(true);

    expect(panel.postMessage.mock.calls[0]![0]).toMatchObject({
      type: "chat-attach",
      sessionId: sid,
    });
    expect(panel.postMessage.mock.calls[1]![0]).toMatchObject({
      type: "chat-chunk",
      text: "早先的一段",
    });

    // The rest of the turn lands in the panel as it happens.
    emit(chunk(sid, "后来的一段"));
    expect(panel.postMessage.mock.calls.at(-1)![0]).toMatchObject({
      type: "chat-chunk",
      text: "后来的一段",
    });

    emit(done(sid));
    expect(panel.postMessage.mock.calls.at(-1)![0]).toMatchObject({ type: "chat-done" });

    // finishRun is fire-and-forget; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(isOverlayRunLive(sid)).toBe(false);
  });

  it("does not attach when no run is live", () => {
    const panel = fakePort();
    expect(attachPanelToRun("no-run", panel as unknown as chrome.runtime.Port)).toBe(false);
    expect(panel.postMessage).not.toHaveBeenCalled();
  });

  it("a disconnected panel stops being a sink", () => {
    const sid = "attach-2";
    const runtime = startOverlayRun(
      sid,
      8,
      fakePort() as unknown as chrome.runtime.Port,
      new AbortController(),
    );
    const emit = wrapOverlayEmit(runtime, () => {});
    const panel = fakePort();
    attachPanelToRun(sid, panel as unknown as chrome.runtime.Port);

    detachPanelFromRun(sid, panel as unknown as chrome.runtime.Port);
    const before = panel.postMessage.mock.calls.length;
    emit(chunk(sid, "after-detach"));
    expect(panel.postMessage.mock.calls.length).toBe(before);
  });

  // HITL: a panel-request inside an overlay run hands the conversation over to
  // the side panel (the card can't render in the page) and tells the overlay.
  it("panel-request handoff opens the panel and notifies the overlay document", async () => {
    const sid = "hitl-1";
    const overlayPort = fakePort();
    startOverlayRun(
      sid,
      11,
      overlayPort as unknown as chrome.runtime.Port,
      new AbortController(),
    );

    await expect(ensurePanelForOverlayRequest(sid)).resolves.toBe(true);
    expect(overlayPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "overlay-notice", sessionId: sid, notice: "panel-request" }),
    );
    expect(openPanel).toHaveBeenCalledWith({ tabId: 11 }, expect.any(String));
  });

  it("declines the handoff for sessions without an overlay run", async () => {
    await expect(ensurePanelForOverlayRequest("no-run")).resolves.toBe(false);
  });
});
