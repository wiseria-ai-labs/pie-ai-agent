/**
 * Navigation-aware click settle: after a click that navigates (links, SPA
 * route changes such as Google Classroom) the tool must not return until the
 * NEW page is there and settled — otherwise the next read_page reads the old
 * page. Clicks that don't navigate must not be slowed beyond the short
 * navigation-start window.
 *
 * The page is simulated: `page` is what probeNavState would report, mutated
 * over time by `script` steps; chrome.scripting.executeScript dispatches on
 * the injected function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "../../test/setup";
import type { ActionResult } from "../dom-actions/types";
import {
  clearPieIndices,
  probeNavState,
  waitForPageReady,
  withActionSettle,
  type NavProbe,
} from "./wait-for-settle";

const TAB = 5;
// Small windows keep tests fast; ratios match the defaults (200 / 500 / 1000 / 10000).
const FAST = { pollMs: 10, quietMs: 40, navStartMs: 100, navTimeoutMs: 600, maxMs: 300, urlOnlyGraceMs: 150 };

let page: NavProbe;
let probeFails = false;
const cleared = vi.fn();

function setPage(patch: Partial<NavProbe>, mutate = true) {
  page = { ...page, ...patch, ...(mutate ? { mutAt: Date.now() } : {}) };
}

beforeEach(() => {
  page = {
    url: "https://classroom.google.com/u/0/h",
    title: "Classes",
    heading: "Classes",
    readyState: "complete",
    mutAt: Date.now() - 10_000,
    loading: false,
  };
  probeFails = false;
  cleared.mockReset();
  (globalThis.chrome as unknown as { scripting: unknown }).scripting = {
    executeScript: vi.fn(async ({ func }: { func: (...a: unknown[]) => unknown }) => {
      if (func === probeNavState) {
        if (probeFails) throw new Error("Frame with ID 0 was removed");
        return [{ result: { ...page } }];
      }
      if (func === clearPieIndices) {
        cleared();
        return [{ result: 3 }];
      }
      return [{ result: undefined }];
    }),
  };
});

afterEach(() => {
  delete (globalThis.chrome as unknown as { scripting?: unknown }).scripting;
});

const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
const click = (onNavigated?: (id: number) => void): Promise<ActionResult> =>
  withActionSettle(TAB, async () => ({ success: true, observation: "Clicked [4]." }), {
    detectNavigation: true,
    onNavigated,
    ...FAST,
  });

describe("withActionSettle — navigation detection", () => {
  it("SPA route change: waits for the new page, invalidates indices, says so", async () => {
    const onNavigated = vi.fn();
    at(30, () => setPage({ url: "https://classroom.google.com/c/123" })); // pushState
    at(80, () => setPage({ heading: "Algebra II", title: "Algebra II" })); // content swaps in later
    const t0 = Date.now();
    const out = await click(onNavigated);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80 + FAST.quietMs);
    expect(out.observation).toContain("Clicked [4].");
    expect(out.observation).toContain("The page navigated.");
    expect(out.observation).toContain("https://classroom.google.com/c/123");
    expect(out.observation).toContain("call read_page");
    expect(cleared).toHaveBeenCalled();
    expect(onNavigated).toHaveBeenCalledWith(TAB);
  });

  it("URL-only change (hash link / same-heading route): settles after the grace, not the full timeout", async () => {
    at(20, () => setPage({ url: "https://classroom.google.com/u/0/h#archived" }));
    const t0 = Date.now();
    const out = await click();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(20 + FAST.urlOnlyGraceMs);
    expect(took).toBeLessThan(FAST.navTimeoutMs);
    expect(out.observation).toContain("The page navigated.");
  });

  it("does not return while a loading spinner is visible", async () => {
    at(20, () => setPage({ url: "https://classroom.google.com/c/9", loading: true }));
    at(250, () => setPage({ loading: false, heading: "Biology" }));
    const t0 = Date.now();
    const out = await click();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(out.observation).toContain("The page navigated.");
  });

  it("cross-document navigation: rides out the tear-down and waits for the new document", async () => {
    at(20, () => (probeFails = true));
    at(150, () => {
      probeFails = false;
      setPage({ url: "https://example.com/next", title: "Next", heading: "Next", readyState: "loading" });
    });
    at(220, () => setPage({ readyState: "complete" }));
    const out = await click();
    expect(out.observation).toContain("The page navigated.");
    expect(out.observation).toContain("https://example.com/next");
  });

  it("non-navigating click (toggle): only the short start window, no note, indices kept", async () => {
    at(10, () => setPage({})); // DOM mutation only — a menu opened
    const t0 = Date.now();
    const out = await click();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(FAST.navStartMs);
    expect(took).toBeLessThan(FAST.navTimeoutMs);
    expect(out.observation).toBe("Clicked [4].");
    expect(cleared).not.toHaveBeenCalled();
  });

  it("click with no effect at all says the page may be unchanged", async () => {
    const out = await click();
    expect(out.observation).toContain("No navigation or page change detected");
    expect(cleared).not.toHaveBeenCalled();
  });

  it("navigation signalled but nothing changes → 'navigation not detected' after the timeout", async () => {
    at(20, () => {
      for (const l of chromeMock.webNavigation.__beforeNavigateListeners) {
        l({ tabId: TAB, frameId: 0 } as chrome.webNavigation.WebNavigationFramedCallbackDetails);
      }
    });
    // keep the DOM busy so the 2s "no visible change" grace never lets it settle
    const busy = setInterval(() => setPage({}), 15);
    try {
      const t0 = Date.now();
      const out = await click();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.navTimeoutMs);
      expect(out.observation).toContain("Navigation not detected");
      expect(out.observation).toContain("may be unchanged");
      expect(cleared).not.toHaveBeenCalled();
    } finally {
      clearInterval(busy);
    }
  });

  it("page changed but still loading at the timeout → partial-page warning", async () => {
    at(20, () => setPage({ url: "https://classroom.google.com/c/7", loading: true }));
    const out = await click();
    expect(out.observation).toContain("still loading");
    expect(cleared).toHaveBeenCalled();
  });

  it("ignores navigation events of other tabs and sub-frames", async () => {
    at(20, () => {
      for (const l of chromeMock.webNavigation.__historyListeners) {
        l({ tabId: 999, frameId: 0 } as chrome.webNavigation.WebNavigationFramedCallbackDetails);
        l({ tabId: TAB, frameId: 3 } as chrome.webNavigation.WebNavigationFramedCallbackDetails);
      }
    });
    const out = await click();
    expect(out.observation).toContain("No navigation or page change detected");
  });

  it("restricted page (probe impossible): falls back to the plain settle, no navigation note", async () => {
    probeFails = true;
    const out = await click();
    expect(out.observation).toBe("Clicked [4].");
  });

  it("a failed action returns at once without waiting", async () => {
    const t0 = Date.now();
    const out = await withActionSettle(TAB, async () => ({ success: false, error: "Element not found" }), {
      detectNavigation: true,
      ...FAST,
    });
    expect(out).toEqual({ success: false, error: "Element not found" });
    expect(Date.now() - t0).toBeLessThan(FAST.navStartMs);
  });

  it("removes every listener it added", async () => {
    await click();
    expect(chromeMock.webNavigation.__beforeNavigateListeners).toHaveLength(0);
    expect(chromeMock.webNavigation.__committedListeners).toHaveLength(0);
    expect(chromeMock.webNavigation.__historyListeners).toHaveLength(0);
  });
});

describe("waitForPageReady", () => {
  it("returns once parsed, quiet and spinner-free", async () => {
    setPage({ readyState: "loading", loading: true });
    at(60, () => setPage({ readyState: "complete" }));
    at(120, () => setPage({ loading: false }));
    const t0 = Date.now();
    const r = await waitForPageReady(TAB, { deadline: Date.now() + 1000, quietMs: 40, pollMs: 10 });
    expect(r.ready).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120 + 40);
  });

  it("reports loading at the deadline", async () => {
    setPage({ loading: true });
    const r = await waitForPageReady(TAB, { deadline: Date.now() + 100, quietMs: 10, pollMs: 10 });
    expect(r).toMatchObject({ ready: false, reason: "loading" });
  });

  it("gives up fast on a page it can never inspect", async () => {
    probeFails = true;
    const t0 = Date.now();
    const r = await waitForPageReady(TAB, { deadline: Date.now() + 5000, pollMs: 10 });
    expect(r).toMatchObject({ ready: false, reason: "unreachable" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("probeNavState (injected, real DOM)", () => {
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    // happy-dom has no layout; treat every element as a visible 10×10 box
    Element.prototype.getBoundingClientRect = function () {
      return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    delete (window as unknown as { __pieMutObs?: unknown }).__pieMutObs;
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    document.body.innerHTML = "";
  });

  it("fingerprints URL, title and the main heading (h1 beats an earlier h2)", () => {
    document.title = "Stream";
    document.body.innerHTML = "<h2>Sidebar</h2><main><h1>  Algebra\n II </h1></main>";
    const p = probeNavState();
    expect(p).toMatchObject({ title: "Stream", heading: "Algebra II", url: location.href, loading: false });
    expect(p.mutAt).toBeGreaterThan(0);
  });

  it.each([
    ['<div aria-busy="true">x</div>', "aria-busy"],
    ['<div role="progressbar"></div>', "indeterminate progressbar"],
    ["<span>Загрузка…</span>", "Russian 'Loading…' text"],
    ["<p>Loading...</p>", "English 'Loading...' text"],
    ['<svg aria-label="Loading"></svg>', "aria-label"],
  ])("detects a visible loading indicator: %s (%s)", (html) => {
    document.body.innerHTML = html;
    expect(probeNavState().loading).toBe(true);
  });

  it.each([
    ['<div role="progressbar" aria-valuenow="40"></div>', "determinate progress bar"],
    ["<p>Loading dock schedule for Monday</p>", "longer sentence"],
    ["<button>Загрузка файлов</button>", "label that merely starts with the word"],
  ])("is not fooled by %s (%s)", (html) => {
    document.body.innerHTML = html;
    expect(probeNavState().loading).toBe(false);
  });

  it("hidden spinners don't count", () => {
    document.body.innerHTML = '<div role="progressbar" style="display:none"></div>';
    expect(probeNavState().loading).toBe(false);
  });

  it("clearPieIndices removes every data-pie-idx stamp", () => {
    document.body.innerHTML = '<a data-pie-idx="1">a</a><button data-pie-idx="2">b</button>';
    expect(clearPieIndices()).toBe(2);
    expect(document.querySelectorAll("[data-pie-idx]")).toHaveLength(0);
  });
});
