import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { checkMonitor, evidenceLine, withDomainLock, type CheckDeps } from "./check";
import { getMonitor, putMonitor } from "./store";
import { MONITOR_NOTIFY_COOLDOWN_MS, type MonitorRecord } from "./types";
import type { ExtractOutcome } from "./extract";

// ── chrome.alarms stub ────────────────────────────────────────────────────────

function installChromeStub() {
  const alarms = new Map<string, number>();
  const create = vi.fn((name: string, info: { when?: number }) => {
    alarms.set(name, info.when ?? 0);
  });
  const clear = vi.fn(async (name: string) => alarms.delete(name));
  const get = vi.fn(async (name: string) => (alarms.has(name) ? { name, scheduledTime: alarms.get(name)! } : undefined));
  (globalThis as unknown as { chrome: unknown }).chrome = { alarms: { create, clear, get } };
  return { alarms, create, clear, get };
}

let stub: ReturnType<typeof installChromeStub>;

beforeEach(async () => {
  await _resetForTests();
  stub = installChromeStub();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function makeMonitor(over: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: "mon_test",
    title: "Sony 降价提醒",
    url: "https://shop.example.com/item/1",
    target: { selector: ".price", sample: "¥2,399" },
    condition: { kind: "number", op: "lt", value: 2000 },
    intervalMinutes: 60,
    expiresAt: NOW + 86400_000,
    fetchMode: "direct",
    status: "active",
    lastMet: false,
    consecutiveFailures: 0,
    history: [],
    createdAt: NOW - 1000,
    ...over,
  };
}

function makeDeps(over: Partial<CheckDeps> = {}): CheckDeps & {
  hits: unknown[];
  pauses: unknown[];
  inbox: unknown[];
  direct: ReturnType<typeof vi.fn>;
  tab: ReturnType<typeof vi.fn>;
} {
  const hits: unknown[] = [];
  const pauses: unknown[] = [];
  const inbox: unknown[] = [];
  const direct = vi.fn(async () => ({ ok: true, value: "¥1,999", via: "selector", fetchMode: "direct" }) as ExtractOutcome);
  const tab = vi.fn(async () => ({ ok: true, value: "¥1,999", via: "selector", fetchMode: "tab" }) as ExtractOutcome);
  return {
    now: () => NOW,
    random: () => 0.5,
    extractDirect: direct,
    extractViaTab: tab,
    notifyHit: vi.fn(async (o: unknown) => {
      hits.push(o);
    }),
    notifyPaused: vi.fn(async (o: unknown) => {
      pauses.push(o);
    }),
    addInbox: vi.fn(async (o: unknown) => {
      inbox.push(o);
      return o as never;
    }),
    hits,
    pauses,
    inbox,
    direct,
    tab,
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkMonitor — edge trigger", () => {
  it("notifies once when the condition first becomes true, then stays quiet", async () => {
    await putMonitor(makeMonitor());
    const deps = makeDeps();

    await checkMonitor("mon_test", deps);
    expect(deps.hits).toHaveLength(1);
    expect(deps.inbox).toHaveLength(1);
    expect((deps.inbox[0] as { kind: string }).kind).toBe("triggered");

    const rec = await getMonitor("mon_test");
    expect(rec?.lastValue).toBe("¥1,999");
    expect(rec?.lastMet).toBe(true);
    expect(rec?.consecutiveFailures).toBe(0);
    // Re-armed with jitter: 60 min * 1.0 (random 0.5) from NOW.
    expect(rec?.nextCheckAt).toBe(NOW + 3600_000);

    await checkMonitor("mon_test", makeDeps());
    // Still met → no second notification.
    expect(deps.hits).toHaveLength(1);
  });

  it("re-notifies after the value falls back out and meets again", async () => {
    await putMonitor(makeMonitor({ lastMet: true, lastValue: "¥1,999", lastNotifiedAt: NOW - MONITOR_NOTIFY_COOLDOWN_MS * 2 }));
    const deps = makeDeps({
      extractDirect: vi.fn(async () => ({ ok: true, value: "¥2,499", via: "selector", fetchMode: "direct" }) as ExtractOutcome),
    });
    await checkMonitor("mon_test", deps);
    expect(deps.hits).toHaveLength(0);
    expect((await getMonitor("mon_test"))?.lastMet).toBe(false);

    const deps2 = makeDeps();
    await checkMonitor("mon_test", deps2);
    expect(deps2.hits).toHaveLength(1);
  });

  it("respects the 1-hour notification cooldown", async () => {
    await putMonitor(
      makeMonitor({ lastMet: true, lastValue: "¥2,499", lastNotifiedAt: NOW - 60_000 }),
    );
    const deps = makeDeps();
    await checkMonitor("mon_test", deps);
    // Edge fired but the cooldown suppresses the notification.
    expect(deps.hits).toHaveLength(0);
    expect(deps.inbox).toHaveLength(0);
  });
});

describe("checkMonitor — event conditions keep firing", () => {
  // Regression: `changed` / `list_added` carry an EVENT ("this poll saw
  // something new"), so gating them on the previous poll's met value made a
  // value that changes every check notify exactly once and then go silent.
  it("notifies on every observed change (cooldown permitting)", async () => {
    await putMonitor(makeMonitor({ condition: { kind: "changed" } }));
    let now = NOW;
    const hits: unknown[] = [];
    for (const v of ["a", "b", "c", "d"]) {
      const deps = makeDeps({
        now: () => now,
        extractDirect: vi.fn(async () => ({ ok: true, value: v, via: "selector", fetchMode: "direct" }) as ExtractOutcome),
      });
      await checkMonitor("mon_test", deps);
      hits.push(...deps.hits);
      now += MONITOR_NOTIFY_COOLDOWN_MS + 1;
    }
    // "a" is the baseline; b / c / d each notify.
    expect(hits).toHaveLength(3);
  });

  it("still rate-limits event conditions to one notification per hour", async () => {
    await putMonitor(makeMonitor({ condition: { kind: "changed" } }));
    const poll = async (v: string, at: number) =>
      makeDeps({
        now: () => at,
        extractDirect: vi.fn(async () => ({ ok: true, value: v, via: "selector", fetchMode: "direct" }) as ExtractOutcome),
      });

    await checkMonitor("mon_test", await poll("a", NOW));          // baseline
    const notified = await poll("b", NOW + 60_000);
    await checkMonitor("mon_test", notified);                      // first notification
    expect(notified.hits).toHaveLength(1);

    const suppressed = await poll("c", NOW + 2 * 60_000);          // 1 min later
    await checkMonitor("mon_test", suppressed);
    expect(suppressed.hits).toHaveLength(0);
  });
});

describe("checkMonitor — fetchMode upgrade", () => {
  it("upgrades to tab mode when direct mode cannot find the target", async () => {
    await putMonitor(makeMonitor({ condition: { kind: "changed" } }));
    const deps = makeDeps({
      extractDirect: vi.fn(async () => ({ ok: false, reason: "not_found", detail: "x" }) as ExtractOutcome),
    });
    deps.extractViaTab = vi.fn(async () => ({ ok: true, value: "¥1,999", via: "selector", fetchMode: "tab" }) as ExtractOutcome);

    await checkMonitor("mon_test", deps);
    expect(deps.extractDirect).toHaveBeenCalledTimes(1);
    expect((await getMonitor("mon_test"))?.fetchMode).toBe("tab");
  });

  it("does not upgrade when the tab fallback fails too", async () => {
    await putMonitor(makeMonitor());
    const deps = makeDeps({
      extractDirect: vi.fn(async () => ({ ok: false, reason: "login", detail: "401" }) as ExtractOutcome),
      extractViaTab: vi.fn(async () => ({ ok: false, reason: "login", detail: "login wall" }) as ExtractOutcome),
    });
    await checkMonitor("mon_test", deps);
    const rec = await getMonitor("mon_test");
    expect(rec?.fetchMode).toBe("direct");
    expect(rec?.consecutiveFailures).toBe(1);
  });

  it("skips the direct path for tab-mode monitors", async () => {
    await putMonitor(makeMonitor({ fetchMode: "tab" }));
    const deps = makeDeps();
    await checkMonitor("mon_test", deps);
    expect(deps.direct).not.toHaveBeenCalled();
    expect(deps.tab).toHaveBeenCalledTimes(1);
  });
});

describe("checkMonitor — failure handling", () => {
  it("pauses after the third consecutive failure, notifying + leaving one needs_action entry", async () => {
    await putMonitor(makeMonitor({ consecutiveFailures: 2 }));
    const deps = makeDeps({
      extractDirect: vi.fn(async () => ({ ok: false, reason: "login", detail: "redirected to /login" }) as ExtractOutcome),
      extractViaTab: vi.fn(async () => ({ ok: false, reason: "login", detail: "login wall" }) as ExtractOutcome),
    });

    await checkMonitor("mon_test", deps);
    const rec = await getMonitor("mon_test");
    expect(rec?.status).toBe("paused");
    expect(rec?.pausedReason).toBe("login");
    expect(rec?.nextCheckAt).toBeUndefined();
    expect(stub.clear).toHaveBeenCalledWith("monitor:mon_test");
    expect(deps.pauses).toHaveLength(1);
    expect(deps.inbox).toHaveLength(1);
    expect((deps.inbox[0] as { kind: string; data?: Record<string, string> }).kind).toBe("needs_action");
    expect((deps.inbox[0] as { data: Record<string, string> }).data.reason).toBe("login");
  });

  it("counts an unparseable number as a failure rather than a miss", async () => {
    await putMonitor(makeMonitor());
    const deps = makeDeps({
      extractDirect: vi.fn(async () => ({ ok: true, value: "sold out", via: "selector", fetchMode: "direct" }) as ExtractOutcome),
    });
    await checkMonitor("mon_test", deps);
    expect((await getMonitor("mon_test"))?.consecutiveFailures).toBe(1);
    expect(deps.hits).toHaveLength(0);
  });

  it("does nothing for a paused monitor", async () => {
    await putMonitor(makeMonitor({ status: "paused" }));
    const deps = makeDeps();
    await checkMonitor("mon_test", deps);
    expect(deps.direct).not.toHaveBeenCalled();
  });

  it("expires a monitor past expiresAt instead of checking it", async () => {
    await putMonitor(makeMonitor({ expiresAt: NOW - 1 }));
    const deps = makeDeps();
    await checkMonitor("mon_test", deps);
    expect(deps.direct).not.toHaveBeenCalled();
    expect((await getMonitor("mon_test"))?.status).toBe("expired");
  });
});

describe("checkMonitor — history", () => {
  it("records changes but not identical polls", async () => {
    await putMonitor(makeMonitor({ condition: { kind: "number", op: "lt", value: 1000 } }));
    const unchanged = makeDeps();
    await checkMonitor("mon_test", unchanged);
    expect((await getMonitor("mon_test"))?.history).toHaveLength(0); // first read = baseline
    const same = makeDeps();
    await checkMonitor("mon_test", same);
    expect((await getMonitor("mon_test"))?.history).toHaveLength(0);
    const changed = makeDeps({
      extractDirect: vi.fn(async () => ({ ok: true, value: "¥999", via: "selector", fetchMode: "direct" }) as ExtractOutcome),
    });
    await checkMonitor("mon_test", changed);
    const rec = await getMonitor("mon_test");
    expect(rec?.history).toHaveLength(1);
    expect(rec?.history[0].value).toBe("¥999");
  });
});

describe("withDomainLock", () => {
  it("serializes same-origin work and lets another origin run concurrently", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = withDomainLock("https://a.com/1", async () => {
      order.push("a1-start");
      await gate;
      order.push("a1-end");
    });
    const b = withDomainLock("https://a.com/2", async () => {
      order.push("a2");
    });
    const c = withDomainLock("https://b.com/1", async () => {
      order.push("b1");
    });
    await c;
    expect(order).toEqual(["a1-start", "b1"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });
});

describe("evidenceLine", () => {
  it("joins previous and next values", () => {
    expect(evidenceLine("¥2,199", "¥1,999")).toBe("¥2,199 → ¥1,999");
    expect(evidenceLine(undefined, "first")).toBe("first");
  });
});
