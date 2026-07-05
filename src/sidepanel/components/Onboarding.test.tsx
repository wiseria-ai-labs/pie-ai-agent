/**
 * Onboarding — F8 (spec §6 I 屏, first-run). Renders the three regions
 * (hero, two entry cards, trust line + skip) and wires the three exit
 * callbacks App relies on to route to the right Settings destination.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import Onboarding from "./Onboarding";

afterEach(() => cleanup());

describe("Onboarding — F8 first-run screen", () => {
  it("renders the hero mark, title, and both entry cards", () => {
    const { container } = render(
      <Onboarding onPickManaged={vi.fn()} onPickByok={vi.fn()} onSkip={vi.fn()} />,
    );
    expect(container.querySelector(".vailie-mark--idle")).toBeTruthy();
    expect(screen.getByText("I'm Vailie.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Subscribe to Vailie Pro/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bring your own API key/ })).toBeTruthy();
  });

  it("renders the trust line and a skip button", () => {
    render(<Onboarding onPickManaged={vi.fn()} onPickByok={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByText(/Open-source Apache-2\.0/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Skip, just looking/ })).toBeTruthy();
  });

  it("calls onPickManaged when the managed card is clicked", () => {
    const onPickManaged = vi.fn();
    render(<Onboarding onPickManaged={onPickManaged} onPickByok={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Subscribe to Vailie Pro/ }));
    expect(onPickManaged).toHaveBeenCalledOnce();
  });

  it("calls onPickByok when the BYOK card is clicked", () => {
    const onPickByok = vi.fn();
    render(<Onboarding onPickManaged={vi.fn()} onPickByok={onPickByok} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Bring your own API key/ }));
    expect(onPickByok).toHaveBeenCalledOnce();
  });

  it("calls onSkip when the skip button is clicked", () => {
    const onSkip = vi.fn();
    render(<Onboarding onPickManaged={vi.fn()} onPickByok={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /Skip, just looking/ }));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
