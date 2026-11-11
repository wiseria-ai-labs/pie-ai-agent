import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readNavProbe, waitForPageLoad, withActionSettle } from "./wait-for-settle";
import { pageAtlasStore } from "./tools/page-atlas/state";
import type { PageAtlasState } from "./tools/page-atlas/types";
import { chromeMock } from "../../test/setup";
import type { ActionResult } from "../dom-actions/types";

// #471 — navigation-aware click settle against a simulated page: injected
// functions run against happy-dom's document; `torndown` simulates the
// window where the old document is gone and the new one isn't injectable.

const TAB = 7;
const FAST = {
  detectNavigation: true,
  quietMs: 50,
  pollMs: 10,
  maxMs: 500,
  navObserveMs: 150,
  navMaxMs: 1500,
  urlOnlyGraceMs: 300,
  navPollMs: 20,
};

let torndown = false;
let restricted = false;
const g = globalThis as unknown as { chrome: Record<string, unknown> };

type W = { __pieMutObs?: MutationObserver; __pieMutAt?: number; __pieMutN?: number };
const w = window as unknown as W;

function resetPage(): void {
  w.__pieMutObs?.disconnect();
  delete w.__pieMutObs;
  delete w.__pieMutAt;
  delete w.__pieMutN;
  history.replaceState(null, "", "/a");
  document.title = "Page A";
  document.body.innerHTML = `<h1>Inbox</h1><button data-pie-idx="0">Go</button><div id="panel"></div>`;
}

/** Simulate a cross-document navigation landing (fresh window state). */
function loadNewDocument(path: string, title: string, body: string): void {
  w.__pieMutObs?.disconnect();
  delete w.__pieMutObs;
  delete w.__pieMutN;
  history.replaceState(null, "", path);
  document.title = title;
  document.body.innerHTML = body;
}

const emit = (
  kind: "__historyListeners" | "__committedListeners" | "__beforeNavigateListeners",
  tabId = TAB,
  frameId = 0,
) => {
  for (const l of [...chromeMock.webNavigation[kind]]) {
    l({ tabId, frameId } as chrome.webNavigation.WebNavigationFramedCallbackDetails);
  }
};

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
const ok: ActionResult = { success: true, observation: "Clicked [0]." };

async function timed(action: () => void | Promise<void>, opts = FAST) {
  const t0 = Date.now();
  const out = await withActionSettle(TAB, async () => {
    await action();
    return { ...ok };
  }, opts);
  return { out, ms: Date.now() - t0 };
}

const fakeAtlas = (id: string, tabId: number) =>
  ({ atlasId: id, tabId, url: "https://x/", origin: null, title: "", createdAt: Date.now() }) as unknown as PageAtlasState;

function expectListenersClean(): void {
  expect(chromeMock.webNavigation.__committedListeners).toHaveLength(0);
  expect(chromeMock.webNavigation.__historyListeners).toHaveLength(0);
  expect(chromeMock.webNavigation.__beforeNavigateListeners).toHaveLength(0);
  expect(chromeMock.tabs.__createdListeners).toHaveLength(0);
}

beforeEach(() => {
  torndown = false;
  restricted = false;
  resetPage();
  pageAtlasStore.clear();
  g.chrome.scripting = {
    executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
      if (restricted) throw new Error("Cannot access contents of the page");
      if (torndown) throw new Error("Frame with ID 0 was removed.");
      return [{ frameId: 0, result: func(...(args ?? [])) }];
    }),
  };
  (chromeMock.webNavigation.getAllFrames as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { frameId: 0, parentFrameId: -1, url: location.href },
  ]);
});

afterEach(() => {
  delete g.chrome.scripting;
  expectListenersClean();
});

describe("withActionSettle — navigation awareness (#471)", () => {
  it("SPA: waits for content that arrives after the URL", async () => {
    pageAtlasStore.save(fakeAtlas("atl_1", TAB));
    pageAtlasStore.save(fakeAtlas("atl_other", TAB + 1));
    const { out, ms } = await timed(
      () => {
        history.pushState(null, "", "/b");
        emit("__historyListeners");
        later(400, () => {
          document.title = "Page B";
          document.body.innerHTML = `<h1>Class B</h1><button>New</button>`;
        });
      },
      { ...FAST, urlOnlyGraceMs: 1000 },
    );
    expect(ms).toBeGreaterThanOrEqual(400);
    expect(ms).toBeLessThan(1000);
    expect(document.title).toBe("Page B");
    expect(out.observation).toContain("The page navigated. Now at ");
    expect(out.observation).toContain("/b");
    expect(pageAtlasStore.get("atl_1")).toBeUndefined();
    expect(pageAtlasStore.get("atl_other")).toBeDefined();
  });

  it("URL-only change settles after the grace period, not the full timeout", async () => {
    const { out, ms } = await timed(() => {
      history.pushState(null, "", "/a?tab=2");
      emit("__historyListeners");
    });
    expect(ms).toBeGreaterThanOrEqual(FAST.urlOnlyGraceMs);
    expect(ms).toBeLessThan(FAST.navMaxMs);
    expect(out.observation).toContain("The page navigated. Now at ");
  });

  it("waits for a loading indicator to disappear", async () => {
    const { out, ms } = await timed(() => {
      history.pushState(null, "", "/c");
      document.title = "Page C";
      document.body.innerHTML = `<h1>C</h1><div aria-busy="true">.</div>`;
      emit("__historyListeners");
      later(500, () => document.querySelector("[aria-busy]")?.remove());
    });
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(out.observation).toContain("The page navigated. Now at ");
  });

  it("reports a page still loading at the timeout", async () => {
    const { out, ms } = await timed(() => {
      history.pushState(null, "", "/d");
      document.title = "D";
      document.body.innerHTML = `<h1>D</h1><span>Loading…</span>`;
      emit("__historyListeners");
    });
    expect(ms).toBeGreaterThanOrEqual(FAST.navMaxMs);
    expect(out.observation).toMatch(/navigated \(now at .*\/d\) but was still loading/);
  });

  it("cross-document teardown: waits for the new document and clears idx", async () => {
    const { out } = await timed(() => {
      emit("__beforeNavigateListeners");
      torndown = true;
      later(150, () => {
        loadNewDocument("/next", "Next", `<h1>Next</h1><a data-pie-idx="3" href="#">stale stamp</a>`);
        torndown = false;
        emit("__committedListeners");
      });
    });
    expect(out.observation).toContain("The page navigated. Now at ");
    expect(out.observation).toContain("/next");
    expect(document.querySelectorAll("[data-pie-idx]")).toHaveLength(0);
  });

  it("beforeNavigate alone does not start URL-only grace — waits for late commit", async () => {
    // Review #479: old document stays complete/tracked until commit at 700ms;
    // urlOnlyGraceMs must not fire off navStartAt from onBeforeNavigate.
    pageAtlasStore.save(fakeAtlas("atl_late", TAB));
    const { out, ms } = await timed(
      () => {
        emit("__beforeNavigateListeners");
        later(700, () => {
          loadNewDocument("/late", "Late", `<h1>Late</h1><button data-pie-idx="9">x</button>`);
          emit("__committedListeners");
        });
      },
      { ...FAST, urlOnlyGraceMs: 200, navMaxMs: 1200, navObserveMs: 100 },
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(out.observation).toContain("The page navigated. Now at ");
    expect(out.observation).toContain("/late");
    expect(pageAtlasStore.get("atl_late")).toBeUndefined();
    expect(document.querySelectorAll("[data-pie-idx]")).toHaveLength(0);
  });

  it("beforeNavigate that never commits waits out the nav budget without clearing refs", async () => {
    pageAtlasStore.save(fakeAtlas("atl_keep", TAB));
    const { out, ms } = await timed(
      () => {
        emit("__beforeNavigateListeners");
      },
      { ...FAST, urlOnlyGraceMs: 200, navMaxMs: 800, navObserveMs: 100 },
    );
    expect(ms).toBeGreaterThanOrEqual(800);
    expect(out.observation).toMatch(/navigation was signalled but the page had not changed/);
    expect(pageAtlasStore.get("atl_keep")).toBeDefined();
    expect(document.querySelector('[data-pie-idx="0"]')).not.toBeNull();
  });

  it("hanging executeScript during nav wait returns by deadline and cleans listeners", async () => {
    let actionDone = false;
    g.chrome.scripting = {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        if (restricted) throw new Error("Cannot access contents of the page");
        if (torndown) throw new Error("Frame with ID 0 was removed.");
        // Pre-action install + fingerprint must succeed; post-action probes hang.
        if (actionDone && func.name === "readNavProbe") {
          return new Promise(() => {});
        }
        return [{ frameId: 0, result: func(...(args ?? [])) }];
      }),
    };
    const t0 = Date.now();
    const out = await withActionSettle(
      TAB,
      async () => {
        actionDone = true;
        emit("__beforeNavigateListeners");
        return { ...ok };
      },
      { ...FAST, navMaxMs: 100, navObserveMs: 50, navPollMs: 10 },
    );
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(300);
    expect(out.success).toBe(true);
    expect(out.observation).toMatch(/navigation was signalled/);
  });

  it("hanging final no-change probe returns by quiet deadline and cleans listeners", async () => {
    // Review #479 round 2: prep + observe + quiet timestamp succeed; only the
    // optional post-quiet no-change probe hangs.
    let quietRead = false;
    g.chrome.scripting = {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        if (func.name === "readMutationTimestamp") {
          quietRead = true;
          return [{ frameId: 0, result: func(...(args ?? [])) }];
        }
        if (func.name === "readNavProbe" && quietRead) {
          return new Promise(() => {});
        }
        return [{ frameId: 0, result: func(...(args ?? [])) }];
      }),
    };
    const t0 = Date.now();
    const out = await withActionSettle(TAB, async () => ({ ...ok }), {
      ...FAST,
      navObserveMs: 30,
      maxMs: 50,
      navMaxMs: 100,
      quietMs: 5,
      pollMs: 5,
      navPollMs: 5,
    });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(out.success).toBe(true);
    // Timed out → skip the no-change note rather than hang.
    expect(out.observation).toBe("Clicked [0].");
  });

  it("hanging pre-action fingerprint returns by prep deadline and cleans listeners", async () => {
    let probeCalls = 0;
    g.chrome.scripting = {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        if (func.name === "readNavProbe") {
          probeCalls++;
          // First probe is the pre-action fingerprint — hang it.
          if (probeCalls === 1) return new Promise(() => {});
        }
        return [{ frameId: 0, result: func(...(args ?? [])) }];
      }),
    };
    const t0 = Date.now();
    const out = await withActionSettle(TAB, async () => ({ ...ok }), {
      ...FAST,
      navObserveMs: 40,
      maxMs: 50,
      quietMs: 5,
      pollMs: 5,
      navPollMs: 5,
    });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(out.success).toBe(true);
    // Prep timeout → quiet-only fallback (no navigation detection / no-change note).
    expect(out.observation).toBe("Clicked [0].");
  });

  it("no nav signal + all post-action injects hanging returns by budget and cleans listeners", async () => {
    let actionDone = false;
    g.chrome.scripting = {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        // Prep install + fingerprint succeed; every post-action inject hangs.
        if (actionDone) return new Promise(() => {});
        return [{ frameId: 0, result: func(...(args ?? [])) }];
      }),
    };
    const t0 = Date.now();
    const out = await withActionSettle(TAB, async () => {
      actionDone = true;
      return { ...ok };
    }, {
      ...FAST,
      navObserveMs: 30,
      maxMs: 50,
      navMaxMs: 100,
      quietMs: 5,
      pollMs: 5,
      navPollMs: 5,
    });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(out.success).toBe(true);
    expect(out.observation).toBe("Clicked [0].");
  });

  it("non-navigating toggle: ~observe window, no note, idx kept", async () => {
    const { out, ms } = await timed(() => {
      document.getElementById("panel")!.innerHTML = "<p>expanded</p>";
    });
    expect(ms).toBeGreaterThanOrEqual(FAST.navObserveMs);
    expect(ms).toBeLessThan(FAST.navObserveMs + 300);
    expect(out.observation).toBe("Clicked [0].");
    expect(document.querySelector('[data-pie-idx="0"]')).not.toBeNull();
  });

  it("attribute-only toggle (aria-expanded) is not reported as no change", async () => {
    const { out } = await timed(() => {
      document.querySelector("button")!.setAttribute("aria-expanded", "true");
    });
    expect(out.observation).toBe("Clicked [0].");
  });

  it("click with no effect says no change was detected", async () => {
    const { out } = await timed(() => {});
    expect(out.observation).toContain("No navigation or page change detected");
    expect(document.querySelector('[data-pie-idx="0"]')).not.toBeNull();
  });

  it("ignores events from other tabs and sub-frames", async () => {
    const { out, ms } = await timed(() => {
      emit("__historyListeners", TAB + 1, 0);
      emit("__beforeNavigateListeners", TAB, 3);
      emit("__committedListeners", TAB, 3);
    });
    expect(ms).toBeLessThan(FAST.navObserveMs + 300);
    expect(out.observation).toContain("No navigation or page change detected");
  });

  it("restricted page falls back to the plain quiet settle", async () => {
    restricted = true;
    const { out, ms } = await timed(() => {
      expect(chromeMock.webNavigation.__beforeNavigateListeners).toHaveLength(0);
    });
    expect(ms).toBeLessThan(FAST.navObserveMs);
    expect(out.observation).toBe("Clicked [0].");
  });

  it("failed action returns at once and cleans up", async () => {
    const out = await withActionSettle(TAB, async () => ({ success: false, error: "nope" }), FAST);
    expect(out.error).toBe("nope");
  });

  it("cleans up listeners when the action throws", async () => {
    await expect(
      withActionSettle(TAB, async () => {
        throw new Error("boom");
      }, FAST),
    ).rejects.toThrow("boom");
  });

  it("reportNoChange:false suppresses the no-change note (in-frame clicks)", async () => {
    const { out } = await timed(() => {}, { ...FAST, reportNoChange: false } as typeof FAST);
    expect(out.observation).toBe("Clicked [0].");
  });
});

describe("readNavProbe busy detection", () => {
  it.each([
    ['<div aria-busy="true">x</div>', true],
    ['<div role="progressbar"></div>', true],
    ['<div role="progressbar" aria-valuenow="40"></div>', false],
    ["<progress></progress>", true],
    ["<span>Loading...</span>", true],
    ["<span>Загрузка…</span>", true],
    ["<span>加载中</span>", true],
    ["<span>読み込み中</span>", true],
    ['<span style="display:none">Loading…</span>', false],
    ["<p>Loading times are faster with the new release.</p>", false],
  ])("%s → busy=%s", (html, busy) => {
    document.body.innerHTML = html;
    expect(readNavProbe().busy).toBe(busy);
  });
});

describe("waitForPageLoad (open_url)", () => {
  it("returns loaded once parsed + quiet + not busy", async () => {
    expect(await waitForPageLoad(TAB, Date.now() + 2000, { quietMs: 50, pollMs: 20 })).toBe("loaded");
  });
  it("returns loading at the deadline when a spinner never clears", async () => {
    document.body.innerHTML = `<div aria-busy="true">.</div>`;
    expect(await waitForPageLoad(TAB, Date.now() + 300, { quietMs: 50, pollMs: 20 })).toBe("loading");
  });
  it("returns unavailable on an unprobeable page", async () => {
    restricted = true;
    expect(await waitForPageLoad(TAB, Date.now() + 5000, { pollMs: 50 })).toBe("unavailable");
  });
  it("hanging executeScript returns by the shared deadline", async () => {
    g.chrome.scripting = {
      executeScript: vi.fn(async () => new Promise(() => {})),
    };
    const t0 = Date.now();
    const status = await waitForPageLoad(TAB, Date.now() + 100, { quietMs: 50, pollMs: 20 });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(status).toBe("loading");
  });
});
