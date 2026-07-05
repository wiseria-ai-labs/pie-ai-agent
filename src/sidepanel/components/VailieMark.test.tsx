import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VailieMark } from "./VailieMark";

describe("VailieMark", () => {
  it("renders the state class and sizes the box", () => {
    const { container } = render(<VailieMark size={32} state="thinking" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("vailie-mark--thinking");
    expect(el.style.width).toBe("32px");
    expect(el.style.height).toBe("32px");
    expect(el.style.backgroundImage).toContain("radial-gradient");
  });

  it("is aria-hidden when decorative, img-role when labelled", () => {
    const { container, rerender } = render(<VailieMark />);
    expect((container.firstElementChild as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    rerender(<VailieMark label="Vailie 正在思考" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Vailie 正在思考");
  });

  it("G3: animate={false} adds the static class (no motion)", () => {
    const { container } = render(<VailieMark state="working" animate={false} />);
    expect((container.firstElementChild as HTMLElement).className).toContain("vailie-mark--static");
  });

  it("never sets border/shadow/clip — shape is the gradient", () => {
    const { container } = render(<VailieMark />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.border).toBe("");
    expect(el.style.boxShadow).toBe("");
    expect(el.style.borderRadius).toBe("");
  });

  it("spreads rest props to the span element (e.g. data-testid)", () => {
    const { container } = render(
      <VailieMark data-testid="vailie-mark-blob" data-custom="test-value" />
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("data-testid")).toBe("vailie-mark-blob");
    expect(el.getAttribute("data-custom")).toBe("test-value");
  });
});
