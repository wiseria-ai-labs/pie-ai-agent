import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import Markdown from "../Markdown";

afterEach(cleanup);

function md(content: string) {
  return render(
    <I18nProvider>
      <Markdown content={content} />
    </I18nProvider>,
  ).container;
}

describe("Markdown — single newline renders as <br> (#472)", () => {
  it("A\\nB renders as two lines in one paragraph", () => {
    const c = md("A\nB");
    expect(c.querySelectorAll("p")).toHaveLength(1);
    expect(c.querySelectorAll("p br")).toHaveLength(1);
  });

  it("blank line still splits paragraphs", () => {
    const c = md("A\n\nB");
    expect(c.querySelectorAll("p")).toHaveLength(2);
    expect(c.querySelectorAll("br")).toHaveLength(0);
  });

  it("no <br> inside fenced or inline code", () => {
    const c = md("```\nline1\nline2\n```\n\nsee `x` here");
    expect(c.querySelector("pre")?.textContent).toContain("line1\nline2");
    expect(c.querySelectorAll("pre br, code br")).toHaveLength(0);
  });

  it("lists and GFM tables are unaffected", () => {
    const c = md("- a\n- b\n\n| h1 | h2 |\n| -- | -- |\n| 1 | 2 |");
    expect(c.querySelectorAll("li")).toHaveLength(2);
    expect(c.querySelectorAll("table td")).toHaveLength(2);
    expect(c.querySelectorAll("br")).toHaveLength(0);
  });
});
