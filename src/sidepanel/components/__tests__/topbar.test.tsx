/**
 * TopBar — v2.0.0 redesign (Task 5, G1/G8): exactly two interactive slots.
 *
 * Mounting the full <App/> tree would require faking the SW port, IndexedDB
 * sessions, and chrome.storage — none of which this task touches. `TopBar` is
 * exported from App.tsx as a small, fully-controlled component (see App.tsx),
 * so it's tested directly here instead.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { TopBar } from "@/sidepanel/App";

afterEach(() => {
  cleanup();
});

function renderTopBar(overrides: Partial<ComponentProps<typeof TopBar>> = {}) {
  const onToggleHub = vi.fn();
  const onNewSession = vi.fn();
  const utils = render(
    <TopBar
      hubOpen={false}
      onToggleHub={onToggleHub}
      pendingCount={0}
      onNewSession={onNewSession}
      sessionTitle="New Session"
      {...overrides}
    />,
  );
  return { ...utils, onToggleHub, onNewSession };
}

describe("v2 top bar (G1/G8)", () => {
  it("has exactly two interactive slots: brand hub trigger + new session", () => {
    renderTopBar();
    expect(screen.getByRole("button", { name: /Vailie/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /新对话|New session/i })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);

    // Old TopBar*Button components are gone — none of their labels survive.
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /theme/i })).toBeNull();
  });

  it("reflects hubOpen via aria-expanded on the hub trigger", () => {
    const { rerender } = renderTopBar({ hubOpen: false });
    const hubButton = screen.getByRole("button", { name: /Vailie/ });
    expect(hubButton.getAttribute("aria-expanded")).toBe("false");

    rerender(
      <TopBar
        hubOpen={true}
        onToggleHub={() => {}}
        pendingCount={0}
        onNewSession={() => {}}
        sessionTitle="New Session"
      />,
    );
    expect(screen.getByRole("button", { name: /Vailie/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("calls onToggleHub / onNewSession when their triggers are clicked", () => {
    const { onToggleHub, onNewSession } = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: /Vailie/ }));
    expect(onToggleHub).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /新对话|New session/i }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("shows a pending badge only when pendingCount > 0", () => {
    const { rerender } = renderTopBar({ pendingCount: 0 });
    expect(screen.queryByLabelText(/pending confirmation|待确认/i)).toBeNull();

    rerender(
      <TopBar
        hubOpen={false}
        onToggleHub={() => {}}
        pendingCount={3}
        onNewSession={() => {}}
        sessionTitle="New Session"
      />,
    );
    expect(screen.getByLabelText(/pending confirmation|待确认/i)).toBeTruthy();
  });
});
