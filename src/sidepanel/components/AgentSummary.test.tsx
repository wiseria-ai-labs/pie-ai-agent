/**
 * AgentSummary — F7 (H 屏最小落地): a static `done` VailieMark marks the
 * turn as concluded. animate={false} keeps it out of the G3 motion budget
 * and — critically — off the bloom-replay-on-scroll hazard (a one-shot
 * completion animation is a separate, deferred piece of work).
 */
import { render, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import AgentSummary from "./AgentSummary";

afterEach(() => cleanup());

describe("AgentSummary — F7 static done mark", () => {
  it("renders a static (non-animated) done-state VailieMark on success", () => {
    const { container } = render(
      <AgentSummary success summary="All done." stepCount={3} />,
    );
    const mark = container.querySelector(".vailie-mark");
    expect(mark).toBeTruthy();
    expect(mark!.className).toContain("vailie-mark--done");
    expect(mark!.className).toContain("vailie-mark--static");
  });

  it("renders the static done mark on failure too (turn-concluded marker, not a success indicator)", () => {
    const { container } = render(
      <AgentSummary success={false} summary="Stopped early." stepCount={2} />,
    );
    const mark = container.querySelector(".vailie-mark");
    expect(mark).toBeTruthy();
    expect(mark!.className).toContain("vailie-mark--done");
    expect(mark!.className).toContain("vailie-mark--static");
  });
});
