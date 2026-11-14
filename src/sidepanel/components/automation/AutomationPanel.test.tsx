import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { _resetForTests } from "@/lib/idb/db";
import { setConfig } from "@/lib/idb/config-store";
import AutomationPanel from "./AutomationPanel";

const counts = vi.hoisted(() => ({ inbox: 2, unread: 1, monitors: 1, schedules: 3 }));

vi.mock("@/lib/inbox/store", () => ({
  listInbox: vi.fn(async () => Array.from({ length: counts.inbox }, (_, i) => ({
    id: `e${i}`, source: "monitor", refId: "m", kind: "triggered",
    title: `Entry ${i}`, body: "", at: Date.now(), read: i !== 0,
  }))),
  unreadInboxCount: vi.fn(async () => counts.unread),
  markAllInboxRead: vi.fn(async () => {}),
}));
vi.mock("@/lib/monitors/store", () => ({
  listMonitors: vi.fn(async () => Array.from({ length: counts.monitors }, (_, i) => ({
    id: `mon_${i}`, title: `Monitor ${i}`, url: "https://x/",
    target: { selector: ".v", sample: "1" }, condition: { kind: "changed" },
    intervalMinutes: 60, expiresAt: Date.now() + 1e9, fetchMode: "direct",
    status: "active", lastMet: false, consecutiveFailures: 0, history: [], createdAt: 1,
  }))),
}));
vi.mock("@/lib/schedules/store", () => ({
  listSchedules: vi.fn(async () => Array.from({ length: counts.schedules }, (_, i) => ({
    id: `sched_${i}`, title: `Schedule ${i}`, prompt: "p", spec: { intervalMinutes: 60 },
    instanceId: "i", enabled: true, status: "active", createdAt: 1, runCount: 0,
    consecutiveFailures: 0, runIds: [],
  }))),
  getRun: vi.fn(async () => null),
  updateRun: vi.fn(async () => {}),
}));
vi.mock("@/lib/monitors/panel-actions", () => ({}));
vi.mock("@/lib/schedules/panel-actions", () => ({
  createSchedule: vi.fn(async () => ({ ok: true })),
  updateSchedule: vi.fn(async () => ({ ok: true })),
  deleteSchedule: vi.fn(async () => ({ ok: true })),
  toggleSchedule: vi.fn(async () => ({ ok: true })),
  runScheduleNow: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/instances", () => ({ listInstances: vi.fn(async () => []) }));
vi.mock("@/lib/model-selection-resolver", () => ({ resolveSelection: vi.fn(async () => null) }));
vi.mock("@/lib/store-bus", () => ({ onStoreChange: vi.fn(() => () => {}), publishChange: vi.fn() }));

beforeEach(async () => {
  await _resetForTests();
  await setConfig(STORAGE_KEY_UI_LOCALE, "en");
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("AutomationPanel", () => {
  it("shows the three segments with counts and lands on 动态", async () => {
    render(<I18nProvider><AutomationPanel onOpenSession={vi.fn()} onCreateViaChat={vi.fn()} /></I18nProvider>);
    expect(await screen.findByTestId("automation-seg-inbox")).toBeTruthy();
    expect(screen.getByTestId("automation-seg-monitors")).toBeTruthy();
    expect(screen.getByTestId("automation-seg-schedules")).toBeTruthy();
    expect(await screen.findByTestId("inbox-feed")).toBeTruthy();
    expect(screen.getByTestId("automation-seg-inbox").getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to the monitor list and then the schedules segment", async () => {
    render(<I18nProvider><AutomationPanel onOpenSession={vi.fn()} onCreateViaChat={vi.fn()} /></I18nProvider>);
    await screen.findByTestId("inbox-feed");

    fireEvent.click(screen.getByTestId("automation-seg-monitors"));
    expect(await screen.findByTestId("monitors-list")).toBeTruthy();
    expect(await screen.findByText("Monitor 0")).toBeTruthy();

    fireEvent.click(screen.getByTestId("automation-seg-schedules"));
    await waitFor(() => expect(screen.queryByTestId("monitors-list")).toBeNull());
    expect(await screen.findByTestId("schedules-page")).toBeTruthy();
  });
});
