import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { getMonitor, listMonitors, putMonitor } from "./store";
import {
  checkMonitorNowOp,
  createMonitorOp,
  deleteMonitorOp,
  pauseMonitorOp,
  resumeMonitorOp,
  setMonitorCheckDep,
  trialMonitor,
  updateMonitorOp,
  validateCondition,
  validateInterval,
  validateUrl,
  VALID_INTERVALS,
} from "./ops";
import { MAX_MONITORS, type MonitorRecord } from "./types";

// Trial extraction hits the network — mock the two extraction entry points.
vi.mock("./extract", async () => {
  const actual = await vi.importActual<typeof import("./extract")>("./extract");
  return { ...actual, extractDirect: vi.fn(), extractViaTab: vi.fn() };
});
const { extractDirect, extractViaTab } = await import("./extract");
const mockedDirect = vi.mocked(extractDirect);
const mockedTab = vi.mocked(extractViaTab);

function installChromeStub() {
  const alarms = new Map<string, number>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    alarms: {
      create: vi.fn((name: string, info: { when?: number }) => {
        alarms.set(name, info.when ?? 0);
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      get: vi.fn(async (name: string) =>
        alarms.has(name) ? { name, scheduledTime: alarms.get(name)! } : undefined,
      ),
    },
  };
  return { alarms };
}

let stub: ReturnType<typeof installChromeStub>;

beforeEach(async () => {
  await _resetForTests();
  stub = installChromeStub();
  vi.clearAllMocks();
  mockedDirect.mockResolvedValue({ ok: true, value: "¥1,999", via: "selector", fetchMode: "direct" });
  mockedTab.mockResolvedValue({ ok: true, value: "¥1,999", via: "selector", fetchMode: "tab" });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

function input(over: Record<string, unknown> = {}) {
  return {
    title: "Sony 降价",
    url: "https://shop.example.com/item/1",
    target: { selector: ".price", sample: "¥2,399" },
    condition: { kind: "number", op: "lt", value: 2000 } as const,
    intervalMinutes: 60 as const,
    fetchMode: "direct" as const,
    initialValue: "¥2,399",
    ...over,
  };
}

describe("validation helpers", () => {
  it("validateUrl rejects non-http and restricted pages", () => {
    expect(validateUrl("https://ok.example.com/")).toBeNull();
    expect(validateUrl("chrome://settings")).toContain("unsupported protocol");
    expect(validateUrl("chrome-extension://abc/page.html")).not.toBeNull();
    expect(validateUrl("about:blank")).not.toBeNull();
    expect(validateUrl("nonsense")).toContain("invalid url");
  });

  it("validateCondition covers all four kinds", () => {
    expect(validateCondition({ kind: "changed" })).toBeNull();
    expect(validateCondition({ kind: "list_added" })).toBeNull();
    expect(validateCondition({ kind: "number", op: "lt", value: 1 })).toBeNull();
    expect(validateCondition({ kind: "number", op: "lt" })).not.toBeNull();
    expect(validateCondition({ kind: "contains", text: " x " })).toBeNull();
    expect(validateCondition({ kind: "contains" })).not.toBeNull();
    expect(validateCondition({ kind: "wat" })).not.toBeNull();
    expect(validateCondition(null)).not.toBeNull();
  });

  it("validateInterval only accepts the four buckets", () => {
    for (const v of VALID_INTERVALS) expect(validateInterval(v)).toBeNull();
    expect(validateInterval(5)).not.toBeNull();
    expect(validateInterval("60")).not.toBeNull();
  });
});

describe("trialMonitor", () => {
  it("reports direct when the plain fetch works", async () => {
    expect(await trialMonitor("https://x/", { selector: ".p", sample: "1" })).toEqual({
      ok: true,
      value: "¥1,999",
      fetchMode: "direct",
    });
    expect(mockedTab).not.toHaveBeenCalled();
  });

  it("falls back to a hidden tab and reports tab mode", async () => {
    mockedDirect.mockResolvedValue({ ok: false, reason: "not_found", detail: "spa" });
    expect(await trialMonitor("https://x/", { selector: ".p", sample: "1" })).toEqual({
      ok: true,
      value: "¥1,999",
      fetchMode: "tab",
    });
  });

  it("reports the direct failure when it was an auth wall", async () => {
    mockedDirect.mockResolvedValue({ ok: false, reason: "login", detail: "401" });
    mockedTab.mockResolvedValue({ ok: false, reason: "network", detail: "timeout" });
    expect(await trialMonitor("https://x/", { selector: ".p", sample: "1" })).toEqual({
      ok: false,
      reason: "login",
      detail: "401",
    });
  });
});

describe("createMonitorOp", () => {
  it("persists the record, seeds the baseline and arms the alarm", async () => {
    const res = await createMonitorOp(input());
    expect(res.ok).toBe(true);
    const rec = (await listMonitors())[0];
    expect(rec).toMatchObject({
      title: "Sony 降价",
      status: "active",
      fetchMode: "direct",
      lastValue: "¥2,399",
      lastMet: false, // 2399 is not < 2000 yet
      consecutiveFailures: 0,
    });
    expect(rec.expiresAt).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect(stub.alarms.has(`monitor:${rec.id}`)).toBe(true);
  });

  it("seeds lastMet=true when the sample already satisfies the condition", async () => {
    mockedDirect.mockResolvedValue({ ok: true, value: "¥999", via: "selector", fetchMode: "direct" });
    const trial = await trialMonitor("https://shop.example.com/item/1", { selector: ".price", sample: "" });
    await createMonitorOp(input({ initialValue: (trial as { value: string }).value }));
    expect((await listMonitors())[0].lastMet).toBe(true);
  });

  it("rejects bad input before touching the store", async () => {
    expect((await createMonitorOp(input({ title: "  " }))).ok).toBe(false);
    expect((await createMonitorOp(input({ url: "chrome://x" }))).ok).toBe(false);
    expect((await createMonitorOp(input({ target: { selector: "" } }))).ok).toBe(false);
    expect((await createMonitorOp(input({ intervalMinutes: 5 }))).ok).toBe(false);
    expect(await listMonitors()).toHaveLength(0);
  });

  it("enforces the 30-monitor quota", async () => {
    for (let i = 0; i < MAX_MONITORS; i++) {
      const rec: MonitorRecord = {
        id: `mon_${i}`,
        title: `m${i}`,
        url: "https://x/",
        target: { selector: ".p", sample: "1" },
        condition: { kind: "changed" },
        intervalMinutes: 60,
        expiresAt: Date.now() + 1e9,
        fetchMode: "direct",
        status: "active",
        lastMet: false,
        consecutiveFailures: 0,
        history: [],
        createdAt: i,
      };
      await putMonitor(rec);
    }
    const res = await createMonitorOp(input());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("quota");
  });
});

describe("update / pause / resume / delete / check-now", () => {
  async function seeded(): Promise<string> {
    const res = await createMonitorOp(input());
    return (await listMonitors())[0].id;
  }

  it("re-arms when the interval changes", async () => {
    const id = await seeded();
    vi.clearAllMocks();
    expect((await updateMonitorOp({ id, intervalMinutes: 15 })).ok).toBe(true);
    expect((await getMonitor(id))?.intervalMinutes).toBe(15);
    expect(stub.alarms.has(`monitor:${id}`)).toBe(true);
  });

  it("clears the edge state when the condition changes", async () => {
    const id = await seeded();
    await updateMonitorOp({ id, condition: { kind: "contains", text: "可预约" } });
    const rec = await getMonitor(id);
    expect(rec?.lastMet).toBe(false);
    expect(rec?.lastNotifiedAt).toBeUndefined();
  });

  it("pause disarms and records the reason; resume re-arms and resets failures", async () => {
    const id = await seeded();
    expect((await pauseMonitorOp(id, "login")).ok).toBe(true);
    expect(await getMonitor(id)).toMatchObject({ status: "paused", pausedReason: "login" });
    expect(stub.alarms.has(`monitor:${id}`)).toBe(false);

    await putMonitor({ ...(await getMonitor(id))!, consecutiveFailures: 3 });
    expect((await resumeMonitorOp(id)).ok).toBe(true);
    expect(await getMonitor(id)).toMatchObject({ status: "active", consecutiveFailures: 0 });
    expect(stub.alarms.has(`monitor:${id}`)).toBe(true);
  });

  it("refuses to resume an expired monitor", async () => {
    const id = await seeded();
    await putMonitor({ ...(await getMonitor(id))!, expiresAt: Date.now() - 1 });
    expect((await resumeMonitorOp(id)).ok).toBe(false);
  });

  it("delete removes the record, the alarm and the inbox rows for it", async () => {
    const id = await seeded();
    const { addInboxEntry, listInbox } = await import("@/lib/inbox/store");
    await addInboxEntry({ source: "monitor", refId: id, kind: "triggered", title: "hit" });
    expect((await deleteMonitorOp(id)).ok).toBe(true);
    expect(await getMonitor(id)).toBeNull();
    expect(stub.alarms.has(`monitor:${id}`)).toBe(false);
    expect(await listInbox()).toHaveLength(0);
  });

  it("check-now dispatches through the injected bound check", async () => {
    const id = await seeded();
    const check = vi.fn(async () => {});
    setMonitorCheckDep(check);
    expect((await checkMonitorNowOp(id)).ok).toBe(true);
    expect(check).toHaveBeenCalledWith(id);

    await pauseMonitorOp(id, "user");
    expect((await checkMonitorNowOp(id)).ok).toBe(false);
  });
});
