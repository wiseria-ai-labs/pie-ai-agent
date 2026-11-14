import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { MonitorDraftCard } from "./MonitorDraftCard";
import type { MonitorDraftPayload } from "@/lib/agent/tools/monitor-meta";

const payload = (over: Partial<MonitorDraftPayload> = {}): MonitorDraftPayload => ({
  title: "Sony 降价提醒",
  url: "https://shop.example.com/item/1",
  condition: { kind: "number", op: "lt", value: 2000 },
  conditionSummary: "below 2000",
  intervalMinutes: 60,
  trial: { ok: true, value: "¥2,399", fetchMode: "direct" },
  ...over,
});

beforeEach(async () => {
  await _resetForTests();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("MonitorDraftCard", () => {
  it("renders the watched value, condition and interval", () => {
    render(<MonitorDraftCard payload={payload()} onSubmit={vi.fn()} />);
    expect(screen.getByText("Sony 降价提醒")).toBeTruthy();
    expect(screen.getByText(/2,?399/)).toBeTruthy();
    expect(screen.getByText("Below 2000")).toBeTruthy();
    expect(screen.getByTestId("monitor-draft-interval")).toBeTruthy();
  });

  it("submits start with the (possibly changed) interval", () => {
    const onSubmit = vi.fn();
    render(<MonitorDraftCard payload={payload()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("monitor-draft-interval"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("monitor-draft-start"));
    expect(onSubmit).toHaveBeenCalledWith({ action: "start", intervalMinutes: 15 });
  });

  it("cancel reports a cancel decision", () => {
    const onSubmit = vi.fn();
    render(<MonitorDraftCard payload={payload()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onSubmit).toHaveBeenCalledWith({ action: "cancel" });
  });

  it("hides 开始监控 and explains the scheduled-task fallback when the trial failed", () => {
    render(
      <MonitorDraftCard
        payload={payload({ trial: { ok: false, reason: "not_found", detail: "x" } })}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("monitor-draft-start")).toBeNull();
    expect(screen.getByTestId("monitor-draft-trial-failed")).toBeTruthy();
    expect(screen.getByText(/scheduled task/i)).toBeTruthy();
  });

  it("uses the login-specific explanation for an auth trial failure", () => {
    render(
      <MonitorDraftCard
        payload={payload({ trial: { ok: false, reason: "login", detail: "401" } })}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(/sign-in/i)).toBeTruthy();
    expect(screen.queryByTestId("monitor-draft-start")).toBeNull();
  });
});
