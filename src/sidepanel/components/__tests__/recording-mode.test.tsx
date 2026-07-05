import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecordingMode from "../RecordingMode";
import type { RecordedAction } from "@/lib/recording/types";

afterEach(() => cleanup());

const action: RecordedAction = {
  type: "click",
  label: "按钮 'Submit'",
  url: "https://example.com",
  region: "main",
  timestamp: 1,
};

describe("RecordingMode — recording indicator IP-ified (Task 13: brand blue + VailieMark)", () => {
  it("live recording renders the VailieMark recording-variant mark (Vital Bar), not a bare pulse dot", () => {
    const { container } = render(
      <RecordingMode
        active
        actions={[action]}
        lastAbortReason={null}
        onFinish={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(container.querySelectorAll(".vailie-mark--recording").length).toBeGreaterThanOrEqual(1);
    // no leftover magenta hex remnants from the old mode color.
    expect(container.innerHTML).not.toContain("194, 96, 190");
  });

  it("aborted state renders reason without throwing", () => {
    const { container } = render(
      <RecordingMode
        active={false}
        actions={[]}
        lastAbortReason="tab-closed"
        onFinish={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("tab-closed");
  });
});
