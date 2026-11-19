import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryUsedChip } from "./MemoryRows";

afterEach(() => cleanup());

const items = [
  { id: "m_1", title: "住在杭州" },
  { id: "m_2", title: "", encrypted: true },
];

describe("MemoryUsedChip", () => {
  it("shows the count and lists titles when expanded", () => {
    render(<MemoryUsedChip items={items} />);
    fireEvent.click(screen.getByText(/Used 2 memories/));
    expect(screen.getByText("住在杭州")).toBeTruthy();
    // Encrypted entries never expose a title.
    expect(screen.getByText(/Encrypted memory/)).toBeTruthy();
  });

  it("renders the overlay-only 不对 entry only when a handler is given", () => {
    const onWrong = vi.fn();
    const { rerender } = render(<MemoryUsedChip items={items} />);
    fireEvent.click(screen.getByText(/Used 2 memories/));
    expect(screen.queryByText("Not right")).toBeNull();

    rerender(<MemoryUsedChip items={items} onWrong={onWrong} />);
    fireEvent.click(screen.getByText("Not right"));
    expect(onWrong).toHaveBeenCalledTimes(1);
  });
});
