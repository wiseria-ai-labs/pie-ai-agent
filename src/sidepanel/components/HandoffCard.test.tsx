import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MotionProvider } from "./ui/motion";
import { HandoffCard } from "./HandoffCard";

afterEach(() => {
  cleanup();
});

function renderCard(props: ComponentProps<typeof HandoffCard>) {
  return render(
    <MotionProvider>
      <HandoffCard {...props} />
    </MotionProvider>,
  );
}

const BRANDS = [
  {
    id: "claude",
    label: "Claude Code",
    forms: [
      { id: "claude-app", kind: "app" as const },
      { id: "claude-terminal", kind: "terminal" as const },
    ],
  },
  {
    id: "codex",
    label: "Codex / ChatGPT",
    forms: [{ id: "codex-terminal", kind: "terminal" as const }],
  },
];

const PAYLOAD = { context: "REFACTOR THE THING", fileCount: 2, brands: BRANDS };

describe("HandoffCard", () => {
  it("renders context verbatim + brand dropdown, first brand preselected", () => {
    renderCard({ payload: PAYLOAD, onDecision: vi.fn() });
    expect(screen.getByText("REFACTOR THE THING")).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("shows App/Terminal segment only when the selected brand has both forms; App is default", () => {
    renderCard({ payload: PAYLOAD, onDecision: vi.fn() });
    const app = screen.getByRole("button", { name: "App" });
    const term = screen.getByRole("button", { name: "Terminal" });
    expect(app.getAttribute("aria-pressed")).toBe("true");
    expect(term.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/prefilled/i)).toBeTruthy();
  });

  it("places the form segment on the same row as the agent select, at most 1/3 width", () => {
    renderCard({ payload: PAYLOAD, onDecision: vi.fn() });
    const group = screen.getByRole("group", { name: "Form" });
    expect(group.className).toMatch(/max-w-\[33%\]/);
    expect(group.parentElement?.className).toMatch(/\bflex\b/);
    expect(group.parentElement?.className).toMatch(/items-end/);
    expect(group.parentElement?.querySelector("button[aria-haspopup='listbox']")).toBeTruthy();
  });

  it("single-form brand hides the form segment", () => {
    renderCard({
      payload: { context: "x", fileCount: 0, brands: [BRANDS[1]] },
      onDecision: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(screen.getByText(/starts automatically/i)).toBeTruthy();
  });

  it("allow returns the default App form id", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { context: "x", fileCount: 0, brands: BRANDS }, onDecision });
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith("claude-app");
  });

  it("switching to Terminal then allow returns the terminal form id", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { context: "x", fileCount: 0, brands: BRANDS }, onDecision });
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith("claude-terminal");
  });

  it("switching brand to a single-form agent returns that form id", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { context: "x", fileCount: 0, brands: BRANDS }, onDecision });
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith("codex-terminal");
  });

  it("deny returns null", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { context: "x", fileCount: 0, brands: BRANDS }, onDecision });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDecision).toHaveBeenCalledWith(null);
  });

  it("dropdown options carry brand icons keyed by brand id", () => {
    renderCard({ payload: PAYLOAD, onDecision: () => {} });
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(document.querySelector('svg[data-brand="claude"]')).toBeTruthy();
    expect(document.querySelector('svg[data-brand="codex"]')).toBeTruthy();
  });

  it("warning register: caps label text-warning; no tool name in the card", () => {
    const { container } = renderCard({ payload: PAYLOAD, onDecision: () => {} });
    expect(screen.getByText("Hand-off").className).toContain("text-warning");
    expect(container.textContent).not.toContain("handoff_to_agent");
  });

  it("Cursor App uses the prefill note now that prompt deeplink is wired", () => {
    renderCard({
      payload: {
        context: "x",
        fileCount: 0,
        brands: [
          {
            id: "cursor",
            label: "Cursor",
            forms: [{ id: "cursor-app", kind: "app" }],
          },
        ],
      },
      onDecision: vi.fn(),
    });
    expect(screen.getByText(/prefilled/i)).toBeTruthy();
  });

  it("uses form kind, not the id suffix, to decide the note", () => {
    renderCard({
      payload: {
        context: "x",
        fileCount: 0,
        brands: [
          {
            id: "weird",
            label: "Weird CLI",
            forms: [{ id: "weird-app", kind: "terminal" }],
          },
        ],
      },
      onDecision: vi.fn(),
    });
    expect(screen.getByText(/starts automatically/i)).toBeTruthy();
    expect(screen.queryByText(/prefilled/i)).toBeNull();
  });
});
