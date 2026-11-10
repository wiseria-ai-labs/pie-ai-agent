import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

// Guards the global afterEach(cleanup) in setup.ts: order-dependent pair.
describe("global Testing Library cleanup", () => {
  it("mounts a tree", () => {
    render(<div data-testid="leak-probe" />);
    expect(document.querySelector('[data-testid="leak-probe"]')).not.toBeNull();
  });

  it("previous test's React tree was unmounted", () => {
    expect(document.querySelector('[data-testid="leak-probe"]')).toBeNull();
    expect(document.body.innerHTML).toBe("");
  });
});
