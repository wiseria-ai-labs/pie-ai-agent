import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { IconButton } from "./IconButton";

afterEach(() => cleanup());

describe("IconButton (无界原语)", () => {
  it("renders a bare icon button with hit-target size", () => {
    const { getByRole } = render(
      <IconButton aria-label="新对话" size={40}>
        <svg />
      </IconButton>
    );
    const btn = getByRole("button", { name: "新对话" });
    expect(btn.style.width).toBe("40px");
    expect(btn.className).toContain("hover:bg-field");
    expect(btn.className).toContain("focus-visible:ring-2");
    expect(btn.className).not.toContain("border");
  });

  it("active paints the accent tint", () => {
    const { getByRole } = render(
      <IconButton aria-label="菜单" active>
        <svg />
      </IconButton>
    );
    expect(getByRole("button", { name: "菜单" }).className).toContain("bg-accent-tint");
  });

  it("does not render border in any case", () => {
    const { getByRole } = render(
      <IconButton aria-label="test" active>
        <svg />
      </IconButton>
    );
    expect(getByRole("button", { name: "test" }).className).not.toContain("border");
  });

  it("renders type='button' even when rest prop tries to override", () => {
    const { getByRole } = render(
      <IconButton aria-label="test" type="submit">
        <svg />
      </IconButton>
    );
    const btn = getByRole("button", { name: "test" }) as HTMLButtonElement;
    expect(btn.type).toBe("button");
  });

  it("uses default size 44px when not specified", () => {
    const { getByRole } = render(
      <IconButton aria-label="test">
        <svg />
      </IconButton>
    );
    const btn = getByRole("button", { name: "test" });
    expect(btn.style.width).toBe("44px");
    expect(btn.style.height).toBe("44px");
  });

  it("applies correct height style when size is specified", () => {
    const { getByRole } = render(
      <IconButton aria-label="test-size" size={32}>
        <svg />
      </IconButton>
    );
    const btn = getByRole("button", { name: "test-size" });
    expect(btn.style.height).toBe("32px");
  });

  it("renders focus-visible ring always", () => {
    const { getByRole } = render(
      <IconButton aria-label="ring-test">
        <svg />
      </IconButton>
    );
    const btn = getByRole("button", { name: "ring-test" });
    expect(btn.className).toContain("focus-visible:ring-2");
    expect(btn.className).toContain("focus-visible:ring-accent-line");
  });

  it("allows additional className to be appended", () => {
    const { getByRole } = render(
      <IconButton aria-label="custom" className="custom-class">
        <svg />
      </IconButton>
    );
    expect(getByRole("button", { name: "custom" }).className).toContain("custom-class");
  });
});
