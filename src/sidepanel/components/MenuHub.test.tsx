import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef } from "react";
import { MenuHub } from "./MenuHub";

afterEach(() => {
  cleanup();
});

const noop = () => {};
// MenuHub renders without an I18nProvider wrapper here (same convention as
// topbar.test.tsx / Chat.test.tsx / ProviderDropdown.test.tsx) — useT() falls
// back to the English dictionary synchronously outside the provider, so
// assertions target the en strings rather than the zh-CN ones.
describe("MenuHub (菜单枢纽,G1:只收低频目的地)", () => {
  it("lists exactly history/skills/schedules/settings + brand footer", () => {
    render(<MenuHub open onClose={noop} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    for (const name of ["Session history", "Skills", "Schedules", "Settings"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.queryByRole("menuitem", { name: /New session/ })).toBeNull(); // 高频不进枢纽
    expect(screen.getByText(/v2\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy();
  });
  it("invokes the route callback then closes", () => {
    const onSkills = vi.fn(); const onClose = vi.fn();
    render(<MenuHub open onClose={onClose} onHistory={noop} onSkills={onSkills} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Skills/ }));
    expect(onSkills).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("closes on Escape and renders nothing when closed", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<MenuHub open onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    rerender(<MenuHub open={false} onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
  it("F9: Escape calls preventDefault, so App's own Esc-to-agent-view handler doesn't double-fire", () => {
    const onClose = vi.fn();
    render(<MenuHub open onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    const notCancelled = fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(notCancelled).toBe(false); // preventDefault() was called on the event
  });
  it("F3: renders an accent count dot on the history row when pendingCount > 0", () => {
    render(<MenuHub open onClose={noop} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" pendingCount={3} />);
    const historyRow = screen.getByRole("menuitem", { name: /Session history/ });
    expect(historyRow.textContent).toContain("3");
  });
  it("F3: renders no dot when pendingCount is 0 or omitted", () => {
    const { rerender } = render(<MenuHub open onClose={noop} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" pendingCount={0} />);
    let historyRow = screen.getByRole("menuitem", { name: /Session history/ });
    expect(historyRow.textContent).toBe("Session history");
    rerender(<MenuHub open onClose={noop} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    historyRow = screen.getByRole("menuitem", { name: /Session history/ });
    expect(historyRow.textContent).toBe("Session history");
  });
  it("closes on an outside click", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button">elsewhere</button>
        <MenuHub open onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />
      </div>,
    );
    fireEvent.mouseDown(screen.getByRole("button", { name: /elsewhere/ }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("ignores mousedown on anchorRef so the trigger's own toggle isn't raced by an outside-click close", () => {
    const onClose = vi.fn();
    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button ref={anchorRef} type="button">hub trigger</button>
          <MenuHub open onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" anchorRef={anchorRef} />
        </div>
      );
    }
    render(<Harness />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /hub trigger/ }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
