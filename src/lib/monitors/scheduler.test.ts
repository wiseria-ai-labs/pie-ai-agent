import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { getMonitor, listMonitors, putMonitor } from "./store";
import {
  armMonitor,
  disarmMonitor,
  handleMonitorAlarm,
  idFromMonitorAlarm,
  nextCheckAt,
  reconcileMonitors,
  type MonitorSchedulerDeps,
} from "./scheduler";
import { MAX_CONCURRENT_MONITOR_CHECKS, type MonitorRecord } from "./types";

function installChromeStub() {
  const alarms = new Map<string, number>();
  const created: Array<{ name: string; when: number }> = [];
  const create = vi.fn((name: string, info: { when?: number }) => {
    alarms.set(name, info.when ?? 0);
    created.push({ name, when: info.when ?? 0 });
  });
  const clear = vi.fn(async (name: string) => alarms.delete(name));
  const get = vi.fn(async (name: string) =>
    alarms.has(name) ? { name, scheduledTime: alarms.get(name)! } : undefined,
  );
  const remove = vi.fn(async () => undefined);
  // Reconcile verifies the persisted tab id still points at our page before
  // closing it (tab ids are reused across browser sessions).
  const tabs = vi.fn(async (id: number) => ({ id, url: "https://x.example.com/" }));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    alarms: { create, clear, get },
    tabs: { remove, get: tabs },
  };
  return { alarms, create, clear, get, remove, tabs };
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

const NOW = 1_700_000_000_000;

function makeMonitor(over: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: "mon_a",
    title: "watch",
    url: "https://x.example.com/",
    target: { selector: ".v", sample: "1" },
    condition: { kind: "changed" },
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

function deps(over: Partial<MonitorSchedulerDeps> = {}): MonitorSchedulerDeps & { checked: string[] } {
  const checked: string[] = [];
  return {
    checkMonitor: vi.fn(async (id: string) => {
      checked.push(id);
    }),
    now: () => NOW,
    random: () => 0.5,
    checked,
    ...over,
  };
}

describe("alarm naming", () => {
  it("round-trips the monitor prefix", () => {
    expect(idFromMonitorAlarm("monitor:mon_1")).toBe("mon_1");
    expect(idFromMonitorAlarm("schedule:sched_1")).toBeNull();
    expect(idFromMonitorAlarm("memory:tick")).toBeNull();
  });
});

describe("nextCheckAt", () => {
  it("applies ±10% jitter deterministically", () => {
    const rec = makeMonitor({ intervalMinutes: 60 });
    expect(nextCheckAt(rec, NOW, () => 0.5)).toBe(NOW + 3600_000); // 1.0x
    expect(nextCheckAt(rec, NOW, () => 0)).toBe(NOW + 3240_000); // 0.9x
    expect(nextCheckAt(rec, NOW, () => 0.999)).toBe(NOW + 3959_280); // 1.0998x
  });
});

describe("armMonitor / disarmMonitor", () => {
  it("creates the alarm and persists nextCheckAt", async () => {
    await putMonitor(makeMonitor());
    const rec = (await getMonitor("mon_a"))!;
    await armMonitor(rec, { now: () => NOW, random: () => 0.5 });
    expect(stub.create).toHaveBeenCalledWith("monitor:mon_a", { when: NOW + 3600_000 });
    expect((await getMonitor("mon_a"))?.nextCheckAt).toBe(NOW + 3600_000);
  });

  it("disarm clears the alarm", async () => {
    await disarmMonitor("mon_a");
    expect(stub.clear).toHaveBeenCalledWith("monitor:mon_a");
  });
});

describe("handleMonitorAlarm", () => {
  it("dispatches a check for its own prefix", async () => {
    const d = deps();
    await handleMonitorAlarm("monitor:mon_a", d);
    expect(d.checked).toEqual(["mon_a"]);
  });

  it("ignores other prefixes", async () => {
    const d = deps();
    await handleMonitorAlarm("schedule:sched_1", d);
    await handleMonitorAlarm("memory:tick", d);
    expect(d.checked).toEqual([]);
  });

  it("defers (does not skip) when the concurrency cap is full", async () => {
    const d = deps({ runningCount: () => MAX_CONCURRENT_MONITOR_CHECKS });
    await handleMonitorAlarm("monitor:mon_a", d);
    expect(d.checked).toEqual([]);
    expect(stub.create).toHaveBeenCalledWith("monitor:mon_a", { when: NOW + 60_000 });
  });
});

describe("reconcileMonitors", () => {
  it("expires past-due monitors and disarms them", async () => {
    await putMonitor(makeMonitor({ expiresAt: NOW - 1 }));
    await reconcileMonitors(NOW, deps());
    const rec = await getMonitor("mon_a");
    expect(rec?.status).toBe("expired");
    expect(stub.clear).toHaveBeenCalledWith("monitor:mon_a");
  });

  it("closes a hidden tab left behind by a dead SW", async () => {
    await putMonitor(makeMonitor({ activeTabId: 42 }));
    await reconcileMonitors(NOW, deps());
    expect(stub.remove).toHaveBeenCalledWith(42);
    expect((await getMonitor("mon_a"))?.activeTabId).toBeUndefined();
  });

  it("never closes a reused tab id that now belongs to another site", async () => {
    await putMonitor(makeMonitor({ activeTabId: 42 }));
    stub.tabs.mockResolvedValue({ id: 42, url: "https://user-bank.example.net/" } as never);
    await reconcileMonitors(NOW, deps());
    expect(stub.remove).not.toHaveBeenCalled();
    // The stale pointer is still cleared so it can't be retried on every boot.
    expect((await getMonitor("mon_a"))?.activeTabId).toBeUndefined();
  });

  it("fires an overdue monitor exactly once (no catch-up burst)", async () => {
    await putMonitor(makeMonitor({ nextCheckAt: NOW - 10 * 60_000 }));
    const d = deps();
    await reconcileMonitors(NOW, d);
    expect(d.checked).toEqual(["mon_a"]);
  });

  it("re-creates a lost alarm in the future", async () => {
    await putMonitor(makeMonitor({ nextCheckAt: NOW + 60_000 }));
    const d = deps();
    await reconcileMonitors(NOW, d);
    expect(d.checked).toEqual([]);
    expect(stub.create).toHaveBeenCalledWith("monitor:mon_a", { when: NOW + 60_000 });
  });

  it("leaves an already-armed monitor alone", async () => {
    await putMonitor(makeMonitor({ nextCheckAt: NOW + 60_000 }));
    stub.alarms.set("monitor:mon_a", NOW + 60_000);
    const d = deps();
    await reconcileMonitors(NOW, d);
    expect(d.checked).toEqual([]);
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("does not arm paused monitors", async () => {
    await putMonitor(makeMonitor({ status: "paused" }));
    await reconcileMonitors(NOW, deps());
    expect(stub.create).not.toHaveBeenCalled();
    expect((await listMonitors()).length).toBe(1);
  });
});
