import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { _resetForTests } from "@/lib/idb/db";
import { setConfig } from "@/lib/idb/config-store";
import { InboxFeed } from "./InboxFeed";
import { MonitorsPanel } from "./MonitorsPanel";
import type { InboxEntry } from "@/lib/inbox/types";
import type { MonitorRecord } from "@/lib/monitors/types";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const entries: InboxEntry[] = [];
const monitors: MonitorRecord[] = [];

vi.mock("@/lib/inbox/store", () => ({
  listInbox: vi.fn(async () => entries.slice()),
  unreadInboxCount: vi.fn(async () => entries.filter((e) => !e.read).length),
  markAllInboxRead: vi.fn(async () => {}),
}));

vi.mock("@/lib/monitors/store", () => ({
  listMonitors: vi.fn(async () => monitors.slice()),
}));

const actionMocks = vi.hoisted(() => ({
  checkMonitorNow: vi.fn(async () => ({ ok: true })),
  deleteMonitor: vi.fn(async () => ({ ok: true })),
  pauseMonitor: vi.fn(async () => ({ ok: true })),
  resumeMonitor: vi.fn(async () => ({ ok: true })),
  updateMonitor: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/monitors/panel-actions", () => actionMocks);

// Captured so a test can simulate the SW writing a check result back.
const storeBusCallbacks: Array<(change: { id?: string }) => void> = [];
vi.mock("@/lib/store-bus", () => ({
  onStoreChange: vi.fn((_store: string, cb: (change: { id?: string }) => void) => {
    storeBusCallbacks.push(cb);
    return () => {};
  }),
  publishChange: vi.fn(),
}));

import { markAllInboxRead } from "@/lib/inbox/store";

function makeEntry(o: Partial<InboxEntry> & { id: string }): InboxEntry {
  return {
    source: "monitor",
    refId: "mon_1",
    kind: "triggered",
    title: "Entry",
    body: "",
    at: Date.now(),
    read: false,
    ...o,
  };
}

function makeMonitor(o: Partial<MonitorRecord> & { id: string }): MonitorRecord {
  return {
    title: "Monitor",
    url: "https://shop.example.com/item/1",
    target: { selector: ".price", sample: "¥2,399" },
    condition: { kind: "number", op: "lt", value: 2000 },
    intervalMinutes: 60,
    expiresAt: Date.now() + 86400000,
    fetchMode: "direct",
    status: "active",
    lastMet: false,
    consecutiveFailures: 0,
    history: [],
    createdAt: 1,
    ...o,
  };
}

const ui = (node: React.ReactNode) =>
  render(<I18nProvider>{node}</I18nProvider>);

beforeEach(async () => {
  await _resetForTests();
  await setConfig(STORAGE_KEY_UI_LOCALE, "en");
  entries.length = 0;
  monitors.length = 0;
  storeBusCallbacks.length = 0;
  vi.clearAllMocks();
});
afterEach(() => cleanup());

// ── InboxFeed ────────────────────────────────────────────────────────────────

describe("InboxFeed", () => {
  it("shows the empty state", async () => {
    ui(<InboxFeed onOpenSession={vi.fn()} />);
    expect(await screen.findByText(/Nothing here yet/i)).toBeTruthy();
  });

  it("renders entries and marks them read on open", async () => {
    entries.push(makeEntry({ id: "e1", title: "Price dropped", body: "¥2,199 → ¥1,999" }));
    ui(<InboxFeed onOpenSession={vi.fn()} />);
    expect(await screen.findByText("Price dropped")).toBeTruthy();
    expect(screen.getByText("¥2,199 → ¥1,999")).toBeTruthy();
    await waitFor(() => expect(markAllInboxRead).toHaveBeenCalled());
  });

  it("offers 打开页面 for monitor entries and opens the recorded URL", async () => {
    entries.push(
      makeEntry({
        id: "e1",
        source: "monitor",
        refId: "mon_1",
        title: "Hit",
        data: { reason: "triggered", url: "https://shop.example.com/item/1" },
      }),
    );
    const open = vi.fn(async () => ({} as chrome.tabs.Tab));
    (globalThis as unknown as { chrome: { tabs: { create: typeof open } } }).chrome = {
      tabs: { create: open },
    };
    ui(<InboxFeed onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open page"));
    expect(open).toHaveBeenCalledWith({ url: "https://shop.example.com/item/1" });
  });

  it("offers 查看会话 for schedule entries and opens the run's session", async () => {
    entries.push(
      makeEntry({
        id: "e2",
        source: "schedule",
        refId: "run_1",
        kind: "done",
        title: "Daily digest",
        data: { status: "success", sessionId: "sess_9" },
      }),
    );
    const onOpenSession = vi.fn();
    ui(<InboxFeed onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByText("View session"));
    expect(onOpenSession).toHaveBeenCalledWith("sess_9");
  });
});

// ── MonitorsPanel ────────────────────────────────────────────────────────────

describe("MonitorsPanel", () => {
  it("shows the empty state with the creation hint", async () => {
    ui(<MonitorsPanel />);
    expect(await screen.findByText(/No monitors yet/i)).toBeTruthy();
  });

  it("lists monitors with condition, interval and current value", async () => {
    monitors.push(makeMonitor({ id: "mon_1", title: "Sony 降价", lastValue: "¥1,999", lastMet: true }));
    ui(<MonitorsPanel />);
    expect(await screen.findByText("Sony 降价")).toBeTruthy();
    expect(screen.getByText("¥1,999")).toBeTruthy();
    expect(screen.getByText("Met")).toBeTruthy();
    expect(screen.getByText(/Below 2000 · Every 1 h/)).toBeTruthy();
  });

  it("shows the paused reason instead of a value", async () => {
    monitors.push(makeMonitor({ id: "mon_2", status: "paused", pausedReason: "login" }));
    ui(<MonitorsPanel />);
    expect(await screen.findByText("Needs sign-in")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("opens the detail view with settings and actions", async () => {
    monitors.push(makeMonitor({ id: "mon_3", title: "Detail me", lastValue: "¥1,999" }));
    ui(<MonitorsPanel />);
    fireEvent.click(await screen.findByTestId("monitor-row-mon_3"));
    expect(await screen.findByTestId("monitor-detail")).toBeTruthy();
    expect(screen.getByText("Check method")).toBeTruthy();
    expect(screen.getByText(/Background fetch/)).toBeTruthy();
    fireEvent.click(screen.getByText("Check now"));
    expect(actionMocks.checkMonitorNow).toHaveBeenCalledWith("mon_3");
  });

  it("shows 检查中 while a manual check is in flight and restores after the result lands", async () => {
    monitors.push(makeMonitor({ id: "mon_6", lastCheckedAt: 1 }));
    ui(<MonitorsPanel />);
    fireEvent.click(await screen.findByTestId("monitor-row-mon_6"));
    fireEvent.click(await screen.findByText("Check now"));

    const checking = await screen.findByText("Checking…");
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Check now")).toBeNull();

    // The SW writes the result and the store-bus nudges the panel.
    monitors[0]!.lastCheckedAt = Date.now() + 1000;
    storeBusCallbacks.forEach((cb) => cb({ id: "unrelated" }));

    await waitFor(() => expect(screen.getByText("Check now")).toBeTruthy());
    expect((screen.getByText("Check now") as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores 立即检查 if the result never lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      monitors.push(makeMonitor({ id: "mon_7" }));
      ui(<MonitorsPanel />);
      fireEvent.click(await screen.findByTestId("monitor-row-mon_7"));
      fireEvent.click(screen.getByText("Check now"));
      expect(await screen.findByText("Checking…")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(screen.getByText("Check now")).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses from the detail view", async () => {
    monitors.push(makeMonitor({ id: "mon_4" }));
    ui(<MonitorsPanel />);
    fireEvent.click(await screen.findByTestId("monitor-row-mon_4"));
    fireEvent.click(await screen.findByText("Pause"));
    expect(actionMocks.pauseMonitor).toHaveBeenCalledWith("mon_4");
  });

  it("deletes only after an explicit confirm", async () => {
    monitors.push(makeMonitor({ id: "mon_5" }));
    ui(<MonitorsPanel />);
    fireEvent.click(await screen.findByTestId("monitor-row-mon_5"));
    fireEvent.click(await screen.findByText("Delete"));
    expect(actionMocks.deleteMonitor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(actionMocks.deleteMonitor).toHaveBeenCalledWith("mon_5"));
  });
});
