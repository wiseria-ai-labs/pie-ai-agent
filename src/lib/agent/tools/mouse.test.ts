import { describe, it, expect, beforeEach, vi } from "vitest";
import { requireCdpInput, dispatchMouseAt, buildHoverTool, buildClickTool, buildClickAtTool, type MouseToolDeps } from "./mouse";
import {
  __clearScreenshotGeometryForTest,
  getScreenshotGeometry,
  recordScreenshotGeometry,
  type ViewportProbe,
} from "../screenshot-geometry";
import type { CdpSession } from "@/background/cdp-session";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";

vi.mock("@/lib/dom-actions/geometry", () => ({
  elementToPagePoint: vi.fn(),
}));

import { elementToPagePoint } from "@/lib/dom-actions/geometry";

const fakeSession = (): CdpSession => ({
  tabId: 7,
  ownerToken: { sessionId: "S1", tabId: 7 },
  generationId: 1,
  isAlive: true,
  detachedReason: null,
  send: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn(),
});

beforeEach(() => {
  const data: Record<string, unknown> = {};
  global.chrome = {
    storage: {
      local: {
        get: vi.fn((k) => {
          const want = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of want) if (key in data) out[key] = data[key];
          return Promise.resolve(out);
        }),
        set: vi.fn((kv) => { Object.assign(data, kv); return Promise.resolve(); }),
        remove: vi.fn(() => Promise.resolve()),
      } as unknown as typeof chrome.storage.local,
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
    } as unknown as typeof chrome.scripting,
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.webNavigation.onCommitted,
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.webNavigation.onHistoryStateUpdated,
      onBeforeNavigate: { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.webNavigation.onBeforeNavigate,
    },
    // #251 — withActionSettle subscribes to tabs.onCreated to detect fanout.
    tabs: {
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as typeof chrome.tabs,
  } as unknown as typeof chrome;
});

describe("dispatchMouseAt", () => {
  it("sends mouseMoved with button=none clickCount=0", async () => {
    const session = fakeSession();
    await dispatchMouseAt(session, 100, 200, "mouseMoved");
    expect(session.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 100,
      y: 200,
      button: "none",
      clickCount: 0,
      pointerType: "mouse",
    });
  });

  it("sends mousePressed with button=left clickCount=1", async () => {
    const session = fakeSession();
    await dispatchMouseAt(session, 50, 60, "mousePressed");
    expect(session.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 50,
      y: 60,
      button: "left",
      clickCount: 1,
      pointerType: "mouse",
    });
  });
});

describe("hover tool", () => {
  beforeEach(async () => {
    await setCdpInputEnabled(true);
    vi.mocked(elementToPagePoint).mockReset();
  });

  function deps(overrides?: Partial<MouseToolDeps>): MouseToolDeps {
    const session = fakeSession();
    return {
      acquireSession: vi.fn().mockResolvedValue(session),
      sessionId: "S1",
      requestConsent: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it("declares write-class schema with required frameId + elementIndex", () => {
    const tool = buildHoverTool(deps());
    expect(tool.name).toBe("hover");
    expect((tool.parameters as { required: string[] }).required).toEqual(
      expect.arrayContaining(["frameId", "elementIndex"]),
    );
  });

  it("description allows indices only from read_page interactive_index", () => {
    const tool = buildHoverTool(deps());
    expect(tool.description).toContain("latest read_page <interactive_index>");
    expect(tool.description).not.toContain("search_page");
    const params = tool.parameters as {
      properties: {
        frameId: { description: string };
        elementIndex: { description: string };
      };
    };
    expect(params.properties.frameId.description).toContain(
      "latest read_page <interactive_index>",
    );
    expect(params.properties.elementIndex.description).toContain(
      "latest read_page <interactive_index>",
    );
    expect(params.properties.frameId.description).not.toContain("search_page");
    expect(params.properties.elementIndex.description).not.toContain("search_page");
  });

  it("returns success observation with mouseMoved dispatched", async () => {
    const session = fakeSession();
    vi.mocked(elementToPagePoint).mockResolvedValue({ x: 100, y: 200 });
    const tool = buildHoverTool(deps({ acquireSession: vi.fn().mockResolvedValue(session) }));
    const result = await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });
    expect(result.success).toBe(true);
    expect(result.observation).toMatch(/Hovered \[3\]/);
    expect(result.observation).toMatch(/read_page/i);
    expect(session.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseMoved", x: 100, y: 200 }),
    );
  });

  it("flag=false re-prompts consent; declined → error", async () => {
    await setCdpInputEnabled(false);
    const requestConsent = vi.fn().mockResolvedValue(false);
    const tool = buildHoverTool(deps({ requestConsent }));
    const result = await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });
    expect(requestConsent).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/declined|not enabled/i);
  });

  it("returns element-not-found error from geometry", async () => {
    vi.mocked(elementToPagePoint).mockResolvedValue({ kind: "element-not-found", index: 3 });
    const tool = buildHoverTool(deps());
    const result = await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Element not found at index 3/);
  });

  it("returns element-not-visible error from geometry", async () => {
    vi.mocked(elementToPagePoint).mockResolvedValue({ kind: "element-not-visible", index: 3 });
    const tool = buildHoverTool(deps());
    const result = await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/zero size|Element \[3\]/);
  });

  it("returns cdp-attach-conflict on acquireSession conflict", async () => {
    const tool = buildHoverTool(
      deps({ acquireSession: vi.fn().mockRejectedValue(new Error("Another debugger is attached")) }),
    );
    const result = await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/another debugger is attached/i);
  });
});

describe("click tool (CDP)", () => {
  beforeEach(async () => {
    await setCdpInputEnabled(true);
    vi.mocked(elementToPagePoint).mockReset();
  });

  function deps(overrides?: Partial<MouseToolDeps>): MouseToolDeps {
    const session = fakeSession();
    return {
      acquireSession: vi.fn().mockResolvedValue(session),
      sessionId: "S1",
      requestConsent: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it("a click that navigates (SPA route) waits for the new page and invalidates indices + atlases", async () => {
    // Fake page: the click (mouseReleased) swaps the route.
    let page = { url: "https://classroom.google.com/h", title: "Classes", heading: "Classes", readyState: "complete", mutAt: Date.now() - 5000, loading: false };
    const cleared = vi.fn();
    chrome.scripting.executeScript = vi.fn(async ({ func }: { func: { name: string } }) => {
      if (func.name === "probeNavState") return [{ result: { ...page } }];
      if (func.name === "clearPieIndices") { cleared(); return [{ result: 2 }]; }
      return [{ result: undefined }];
    }) as unknown as typeof chrome.scripting.executeScript;
    const session = fakeSession();
    vi.mocked(session.send).mockImplementation(async (_m: string, params?: unknown) => {
      if ((params as { type?: string })?.type === "mouseReleased") {
        page = { ...page, url: "https://classroom.google.com/c/42", title: "Algebra", heading: "Algebra", mutAt: Date.now() };
      }
      return undefined;
    });
    vi.mocked(elementToPagePoint).mockResolvedValue({ x: 10, y: 20 });
    const { pageAtlasStore } = await import("./page-atlas/state");
    const invalidate = vi.spyOn(pageAtlasStore, "invalidateTab");

    const tool = buildClickTool(deps({ acquireSession: vi.fn().mockResolvedValue(session) }));
    const result = await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });

    expect(result.success).toBe(true);
    expect(result.observation).toContain("The page navigated.");
    expect(result.observation).toContain("https://classroom.google.com/c/42");
    expect(cleared).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith(7);
  });

  it("declares write-class schema with required frameId + elementIndex", () => {
    const tool = buildClickTool(deps());
    expect(tool.name).toBe("click");
    expect((tool.parameters as { required: string[] }).required).toEqual(
      expect.arrayContaining(["frameId", "elementIndex"]),
    );
  });

  it("description allows indices only from read_page interactive_index", () => {
    const tool = buildClickTool(deps());
    expect(tool.description).toContain("latest read_page <interactive_index>");
    expect(tool.description).not.toContain("search_page");
    const params = tool.parameters as {
      properties: {
        frameId: { description: string };
        elementIndex: { description: string };
      };
    };
    expect(params.properties.frameId.description).toContain(
      "latest read_page <interactive_index>",
    );
    expect(params.properties.elementIndex.description).toContain(
      "latest read_page <interactive_index>",
    );
    expect(params.properties.frameId.description).not.toContain("search_page");
    expect(params.properties.elementIndex.description).not.toContain("search_page");
  });

  it("dispatches mouseMoved → mousePressed → mouseReleased", async () => {
    const session = fakeSession();
    vi.mocked(elementToPagePoint).mockResolvedValue({ x: 150, y: 250 });
    const tool = buildClickTool(deps({ acquireSession: vi.fn().mockResolvedValue(session) }));
    const result = await tool.handler({ frameId: 0, elementIndex: 5 }, { tabId: 7 });
    expect(result.success).toBe(true);
    const sendMock = session.send as ReturnType<typeof vi.fn>;
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[0][1].type).toBe("mouseMoved");
    expect(sendMock.mock.calls[1][1].type).toBe("mousePressed");
    expect(sendMock.mock.calls[2][1].type).toBe("mouseReleased");
  });

  it("includes coords in observation", async () => {
    const session = fakeSession();
    vi.mocked(elementToPagePoint).mockResolvedValue({ x: 150, y: 250 });
    const tool = buildClickTool(deps({ acquireSession: vi.fn().mockResolvedValue(session) }));
    const result = await tool.handler({ frameId: 0, elementIndex: 5 }, { tabId: 7 });
    expect(result.observation).toMatch(/Clicked \[5\]/);
    expect(result.observation).toMatch(/150.*250/);
  });

  it("flag=false re-prompts consent; declined → error", async () => {
    await setCdpInputEnabled(false);
    const requestConsent = vi.fn().mockResolvedValue(false);
    const tool = buildClickTool(deps({ requestConsent }));
    const result = await tool.handler({ frameId: 0, elementIndex: 5 }, { tabId: 7 });
    expect(requestConsent).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/declined|not enabled/i);
  });

  it("returns cdp-attach-conflict on debugger conflict", async () => {
    const tool = buildClickTool(
      deps({ acquireSession: vi.fn().mockRejectedValue(new Error("Another debugger is attached")) }),
    );
    const result = await tool.handler({ frameId: 0, elementIndex: 5 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/another debugger is attached/i);
  });

  it("returns element-not-found error from geometry", async () => {
    vi.mocked(elementToPagePoint).mockResolvedValue({ kind: "element-not-found", index: 5 });
    const tool = buildClickTool(deps());
    const result = await tool.handler({ frameId: 0, elementIndex: 5 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Element not found at index 5/);
  });

  it("missing frameId falls into the CDP top-frame path (not synthetic)", async () => {
    const session = fakeSession();
    const acquireSession = vi.fn().mockResolvedValue(session);
    vi.mocked(elementToPagePoint).mockResolvedValue({ x: 80, y: 90 });
    const tool = buildClickTool(deps({ acquireSession }));
    const result = await tool.handler({ elementIndex: 4 }, { tabId: 7 });
    expect(result.success).toBe(true);
    expect(acquireSession).toHaveBeenCalledWith(7);
    expect(result.observation).not.toContain("synthetic");
  });
});

describe("click tool — subframe synthetic path", () => {
  // NOTE: no setCdpInputEnabled here — these cases verify the subframe path
  // never touches the CDP gate (no consent prompt, no attach).

  function deps(overrides?: Partial<MouseToolDeps>): MouseToolDeps {
    const session = fakeSession();
    return {
      acquireSession: vi.fn().mockResolvedValue(session),
      sessionId: "S1",
      requestConsent: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it("frameId>0 clicks in-frame without CDP attach or consent", async () => {
    // withActionSettle probes also go through executeScript (no `args`);
    // return the act result only for the act-core invocation so the settle
    // loop sees a clean numeric timestamp and exits on quietMs.
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockImplementation(
      async (injection: { args?: unknown[] }) =>
        injection.args
          ? [{ result: { ok: true, op: "click", observation: "Clicked element [4]" } }]
          : [{ result: undefined }],
    );
    const acquireSession = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildClickTool({ acquireSession, sessionId: "S1", requestConsent });
    const result = await tool.handler({ frameId: 5, elementIndex: 4 }, { tabId: 7 });
    expect(result.success).toBe(true);
    expect(result.observation).toContain("synthetic events");
    expect(result.observation).toContain("frame 5");
    expect(acquireSession).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [5] } }),
    );
  });

  it("string frameId is coerced and routed to the synthetic path", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockImplementation(
      async (injection: { args?: unknown[] }) =>
        injection.args
          ? [{ result: { ok: true, op: "click", observation: "Clicked element [4]" } }]
          : [{ result: undefined }],
    );
    const acquireSession = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildClickTool({ acquireSession, sessionId: "S1", requestConsent });
    const result = await tool.handler(
      { frameId: "5" as unknown as number, elementIndex: 4 },
      { tabId: 7 },
    );
    expect(result.success).toBe(true);
    expect(result.observation).toContain("frame 5");
    expect(acquireSession).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [5] } }),
    );
  });

  it("frameId>0 with vanished frame returns unreachable error", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("No frame with id 21114 in tab 7"),
    );
    const tool = buildClickTool(deps());
    const result = await tool.handler({ frameId: 21114, elementIndex: 49 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Frame 21114 unreachable or removed. Re-snapshot.");
  });

  it("frameId>0 element-not-found passes act-core error through", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: false, error: "Element not found at index 4. The page may have changed; try snapshotting again." } },
    ]);
    const tool = buildClickTool(deps());
    const result = await tool.handler({ frameId: 5, elementIndex: 4 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found at index 4");
  });
});

describe("hover tool — subframe gate", () => {
  it("frameId>0 returns top-frame-only error without CDP attach or consent", async () => {
    const acquireSession = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHoverTool({ acquireSession, sessionId: "S1", requestConsent });
    const result = await tool.handler({ frameId: 3, elementIndex: 1 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("top frame");
    expect(acquireSession).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
  });
});

describe("requireCdpInput", () => {
  it("returns ok=true when flag=true", async () => {
    await setCdpInputEnabled(true);
    const result = await requireCdpInput({ sessionId: "S1", requestConsent: async () => true });
    expect(result.ok).toBe(true);
  });

  it("flag=false re-prompts consent (granted → ok)", async () => {
    await setCdpInputEnabled(false);
    const requestConsent = vi.fn().mockResolvedValue(true);
    const result = await requireCdpInput({ sessionId: "S1", requestConsent });
    expect(requestConsent).toHaveBeenCalledWith("S1");
    expect(result.ok).toBe(true);
  });

  it("calls requestConsent when flag=undefined and resolves true → ok", async () => {
    const requestConsent = vi.fn().mockResolvedValue(true);
    const result = await requireCdpInput({ sessionId: "S1", requestConsent });
    expect(requestConsent).toHaveBeenCalledWith("S1");
    expect(result.ok).toBe(true);
  });

  it("returns declined error when consent declined", async () => {
    const result = await requireCdpInput({
      sessionId: "S1",
      requestConsent: async () => false,
    });
    expect(result).toEqual({
      ok: false,
      error: "CDP input not enabled — the user declined. This action requires CDP and can't be performed otherwise.",
    });
  });

  it("returns onboarding-cancelled when requestConsent throws", async () => {
    const result = await requireCdpInput({
      sessionId: "S1",
      requestConsent: async () => { throw new Error("panel-request cancelled (panel closed) for session S1"); },
    });
    expect(result).toEqual({
      ok: false,
      error: "Onboarding cancelled (panel closed).",
    });
  });
});

describe("click_at tool", () => {
  const PROBE: ViewportProbe = { url: "https://docs.google.com/document/d/x/edit", cssWidth: 1440, cssHeight: 900, dpr: 2, scrollX: 0, scrollY: 0 };

  function mockProbe(p: ViewportProbe | undefined = PROBE) {
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async (inj: { func?: { name?: string } }) =>
      inj.func?.name === "viewportProbeInjected" ? [{ result: p }] : [{ result: undefined }]) as never);
  }

  function seedScreenshot(over: Partial<ViewportProbe> = {}) {
    // 1440x900 CSS @ DPR 2 → resized to 1568x980.
    recordScreenshotGeometry("S1", 7, { ...PROBE, ...over, imageWidth: 1568, imageHeight: 980, capturedAt: Date.now() });
  }

  function deps(overrides?: Partial<MouseToolDeps>): MouseToolDeps {
    return {
      acquireSession: vi.fn().mockResolvedValue(fakeSession()),
      sessionId: "S1",
      requestConsent: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await setCdpInputEnabled(true);
    __clearScreenshotGeometryForTest();
    mockProbe();
  });

  it("schema: x/y required, no frameId (top frame only)", () => {
    const tool = buildClickAtTool(deps());
    expect(tool.name).toBe("click_at");
    expect((tool.parameters as { required: string[] }).required).toEqual(["x", "y"]);
    expect(tool.description).toMatch(/USE WHEN/);
    expect(tool.description).toMatch(/DO NOT USE WHEN/);
  });

  it("without a prior screenshot → error, no CDP attach", async () => {
    const acquireSession = vi.fn();
    const tool = buildClickAtTool(deps({ acquireSession }));
    const r = await tool.handler({ x: 10, y: 10 }, { tabId: 7 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/capture_visible_tab/);
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it("dispatches move → press → release at mapped viewport coords", async () => {
    seedScreenshot();
    const session = fakeSession();
    const tool = buildClickAtTool(deps({ acquireSession: vi.fn().mockResolvedValue(session) }));
    const r = await tool.handler({ x: 392, y: 490 }, { tabId: 7 });
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/viewport \(360,450\)/);
    const events = vi.mocked(session.send).mock.calls
      .filter(([m]) => m === "Input.dispatchMouseEvent")
      .map(([, p]) => p as Record<string, unknown>);
    expect(events.map((e) => [e.type, e.button, e.clickCount])).toEqual([
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 1],
    ]);
    for (const e of events) expect(e).toMatchObject({ x: 360, y: 450 });
  });

  it("clickCount 3 sends press/release runs with increasing clickCount", async () => {
    seedScreenshot();
    const session = fakeSession();
    const tool = buildClickAtTool(deps({ acquireSession: vi.fn().mockResolvedValue(session) }));
    const r = await tool.handler({ x: 10, y: 10, clickCount: 3, button: "left" }, { tabId: 7 });
    expect(r.success).toBe(true);
    const counts = vi.mocked(session.send).mock.calls
      .map(([, p]) => p as Record<string, unknown>)
      .filter((p) => p.type !== "mouseMoved")
      .map((p) => `${p.type}:${p.clickCount}`);
    expect(counts).toEqual([
      "mousePressed:1", "mouseReleased:1",
      "mousePressed:2", "mouseReleased:2",
      "mousePressed:3", "mouseReleased:3",
    ]);
  });

  it("invalidates the screenshot geometry after a successful click", async () => {
    seedScreenshot();
    const tool = buildClickAtTool(deps());
    expect((await tool.handler({ x: 10, y: 10 }, { tabId: 7 })).success).toBe(true);
    expect(getScreenshotGeometry("S1", 7)).toBeUndefined();
    const again = await tool.handler({ x: 10, y: 10 }, { tabId: 7 });
    expect(again.success).toBe(false);
  });

  it("CDP gate: declined consent → error, no session, no events", async () => {
    await setCdpInputEnabled(false);
    seedScreenshot();
    const acquireSession = vi.fn();
    const requestConsent = vi.fn().mockResolvedValue(false);
    const tool = buildClickAtTool(deps({ acquireSession, requestConsent }));
    const r = await tool.handler({ x: 10, y: 10 }, { tabId: 7 });
    expect(requestConsent).toHaveBeenCalledWith("S1");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/declined/);
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it("page scrolled since the screenshot → stale error, no click", async () => {
    seedScreenshot();
    mockProbe({ ...PROBE, scrollY: 250 });
    const acquireSession = vi.fn();
    const tool = buildClickAtTool(deps({ acquireSession }));
    const r = await tool.handler({ x: 10, y: 10 }, { tabId: 7 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("take capture_visible_tab again");
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it("page scrolled while the CDP consent card was open → stale error, no click", async () => {
    await setCdpInputEnabled(false);
    seedScreenshot();
    const session = fakeSession();
    // The user scrolls while deciding; consent resolves after the scroll.
    const requestConsent = vi.fn(async () => {
      mockProbe({ ...PROBE, scrollY: 400 });
      return true;
    });
    const tool = buildClickAtTool(deps({ acquireSession: vi.fn().mockResolvedValue(session), requestConsent }));
    const r = await tool.handler({ x: 10, y: 10 }, { tabId: 7 });
    expect(requestConsent).toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.error).toContain("take capture_visible_tab again");
    expect(vi.mocked(session.send)).not.toHaveBeenCalled();
    expect(getScreenshotGeometry("S1", 7)).toBeUndefined();
  });

  it("viewport shrinks on debugger attach (infobar) → stale error, no click", async () => {
    seedScreenshot();
    const session = fakeSession();
    const acquireSession = vi.fn(async () => {
      mockProbe({ ...PROBE, cssHeight: 864 });
      return session;
    });
    const tool = buildClickAtTool(deps({ acquireSession }));
    const r = await tool.handler({ x: 10, y: 10 }, { tabId: 7 });
    expect(acquireSession).toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/resized/);
    expect(vi.mocked(session.send)).not.toHaveBeenCalled();
  });

  it("out-of-bounds point → error", async () => {
    seedScreenshot();
    const tool = buildClickAtTool(deps());
    const r = await tool.handler({ x: 5000, y: 10 }, { tabId: 7 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside the screenshot/);
  });

  it("rejects an invalid clickCount / button", async () => {
    seedScreenshot();
    const tool = buildClickAtTool(deps());
    expect((await tool.handler({ x: 1, y: 1, clickCount: 4 }, { tabId: 7 })).success).toBe(false);
    expect((await tool.handler({ x: 1, y: 1, button: "back" }, { tabId: 7 })).success).toBe(false);
  });
});
