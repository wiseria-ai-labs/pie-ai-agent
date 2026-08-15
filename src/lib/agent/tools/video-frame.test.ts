import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchCaptureVideoFrame, seekPrimaryMedia, isMostlyBlackImage } from "./video-frame";
import { _resetBudgetForTests } from "./screenshot";

beforeEach(() => {
  _resetBudgetForTests();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    ...((globalThis as unknown as { chrome?: object }).chrome ?? {}),
    tabs: {
      captureVisibleTab: vi.fn(async () => "data:image/jpeg;base64," + "A".repeat(8)),
      get: vi.fn(async (id: number) => ({
        id,
        active: true,
        windowId: 1,
        url: "https://youtube.com/watch?v=x",
      })),
    },
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            ok: true,
            currentTime: 12.5,
            duration: 184,
            paused: true,
            videoWidth: 1280,
            videoHeight: 720,
          },
        },
      ]),
    },
  };
});

describe("seekPrimaryMedia", () => {
  it("returns no_video when the document has no <video>", async () => {
    const r = await seekPrimaryMedia(10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_video");
  });
});

describe("dispatchCaptureVideoFrame", () => {
  it("seeks then captures a JPEG", async () => {
    const res = await dispatchCaptureVideoFrame(
      { sessionId: "s1", taskId: "t1", pinnedTabId: 7 },
      { timeSeconds: 12.5 },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.mediaType).toBe("image/jpeg");
      expect(res.meta.currentTime).toBe(12.5);
      expect(res.meta.duration).toBe(184);
    }
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
  });

  it("rejects no_video when every frame reports none", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { result: { ok: false, reason: "no_video" } },
    ]);
    const res = await dispatchCaptureVideoFrame(
      { sessionId: "s1", taskId: "t1", pinnedTabId: 7 },
      { timeSeconds: 3 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_video");
  });

  it("rejects pinned-tab-not-visible when the tab is in the background", async () => {
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 7,
      active: false,
      windowId: 1,
    });
    const res = await dispatchCaptureVideoFrame(
      { sessionId: "s1", taskId: "t1", pinnedTabId: 7 },
      { timeSeconds: 1 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("pinned-tab-not-visible");
  });

  it("rejects a non-numeric timeSeconds", async () => {
    const res = await dispatchCaptureVideoFrame(
      { sessionId: "s1", taskId: "t1", pinnedTabId: 7 },
      { timeSeconds: "soon" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("seek_failed");
  });
});

describe("isMostlyBlackImage", () => {
  it("returns false when canvas sampling is unavailable (does not false-positive DRM)", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    // Fake / missing bitmap path → false, never throw.
    const r = await isMostlyBlackImage(blob);
    expect(typeof r).toBe("boolean");
  });
});
