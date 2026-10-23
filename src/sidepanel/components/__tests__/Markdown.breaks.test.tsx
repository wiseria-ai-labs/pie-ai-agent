import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import Markdown from "../Markdown";

afterEach(cleanup);

function md(content: string) {
  const { container } = render(
    <I18nProvider>
      <Markdown content={content} />
    </I18nProvider>,
  );
  return container;
}

describe("Markdown — single newlines are line breaks", () => {
  it('"A\\nB" renders as two lines', () => {
    const c = md("A\nB");
    const p = c.querySelector("p")!;
    expect(p.querySelectorAll("br")).toHaveLength(1);
    expect(p.innerHTML.replace(/\s+/g, "")).toBe("A<br>B");
  });

  it("a blank line still starts a new paragraph", () => {
    const c = md("A\n\nB");
    expect(c.querySelectorAll("p")).toHaveLength(2);
    expect(c.querySelectorAll("br")).toHaveLength(0);
  });

  it("fenced code blocks keep their newlines verbatim (no <br>)", () => {
    const c = md("```\nline1\nline2\n```");
    const pre = c.querySelector("pre")!;
    expect(pre.querySelectorAll("br")).toHaveLength(0);
    expect(pre.textContent).toContain("line1\nline2");
  });

  it("lists still render as lists", () => {
    const c = md("Steps:\n- one\n- two\n\n1. first\n2. second");
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
    expect(c.querySelectorAll("ol > li")).toHaveLength(2);
    expect(c.querySelector("li")!.textContent).toBe("one");
  });

  it("a list item's own wrapped line breaks inside the item", () => {
    const c = md("- first line\n  second line\n- next");
    const items = c.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelectorAll("br")).toHaveLength(1);
  });

  it("tables (GFM) are unaffected", () => {
    const c = md("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(c.querySelectorAll("table td")).toHaveLength(2);
    expect(c.querySelectorAll("br")).toHaveLength(0);
  });
});
