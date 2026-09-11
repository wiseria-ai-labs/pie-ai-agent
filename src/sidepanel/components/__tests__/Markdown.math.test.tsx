import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/** KaTeX emits an MathML `<annotation encoding="application/x-tex">` holding
 * the exact source it rendered — the most direct assertion that a given
 * formula went through KaTeX rather than landing as literal text. */
function renderedTex(container: HTMLElement): string[] {
  return [...container.querySelectorAll("annotation")].map((a) =>
    (a.textContent ?? "").trim(),
  );
}

describe("Markdown — math rendering (#447)", () => {
  it("renders $…$ as inline math", () => {
    const c = md("Einstein wrote $E=mc^2$ in 1905.");
    expect(renderedTex(c)).toEqual(["E=mc^2"]);
    expect(c.querySelector(".katex-display")).toBeNull();
    expect(c.textContent).toContain("in 1905");
    // Pin the structural class the stylesheet's box-model rules target; see
    // the stylesheet/renderer agreement test at the bottom of this file.
    expect(c.querySelector(".katex .base")).not.toBeNull();
  });

  it("renders $$…$$ on its own line as display math", () => {
    const c = md("Result:\n\n$$\\int_0^\\infty e^{-x}dx = 1$$\n");
    expect(renderedTex(c)).toEqual(["\\int_0^\\infty e^{-x}dx = 1"]);
    expect(c.querySelector(".katex-display")).not.toBeNull();
  });

  it("renders $$…$$ spanning its own fence lines as display math", () => {
    const c = md("Result:\n\n$$\n\\frac{a}{b}\n$$\n");
    expect(renderedTex(c)).toEqual(["\\frac{a}{b}"]);
    expect(c.querySelector(".katex-display")).not.toBeNull();
  });

  it("renders the \\(…\\) and \\[…\\] delimiters models also emit", () => {
    const inline = md("Mass-energy: \\(E=mc^2\\) holds.");
    expect(renderedTex(inline)).toEqual(["E=mc^2"]);
    expect(inline.querySelector(".katex-display")).toBeNull();

    const block = md("Then:\n\n\\[x^2 + y^2 = z^2\\]\n");
    expect(renderedTex(block)).toEqual(["x^2 + y^2 = z^2"]);
    expect(block.querySelector(".katex-display")).not.toBeNull();
  });

  it("degrades a malformed / half-streamed formula to readable text", () => {
    // What the panel sees mid-stream, before the closing brace arrives.
    const c = md("Partial:\n\n$$\n\\frac{1\n$$\n");
    expect(c.querySelector(".katex-error")?.textContent).toContain("\\frac{1");
    expect(c.textContent).toContain("Partial:");
  });

  it("leaves $ inside fenced and inline code alone", () => {
    const c = md(
      "Shell: `echo $HOME` and\n\n```sh\ncost=$100\necho $PATH\n```\n",
    );
    expect(renderedTex(c)).toEqual([]);
    expect(c.querySelector("code")?.textContent).toBe("echo $HOME");
    expect(c.querySelector("pre")?.textContent).toContain("cost=$100");
  });

  it("leaves \\[…\\] inside a fenced block as literal source", () => {
    const c = md("```tex\n\\[x^2\\]\n```\n");
    expect(renderedTex(c)).toEqual([]);
    expect(c.querySelector("pre")?.textContent).toContain("\\[x^2\\]");
  });
  it("survives every prefix of a streamed formula", () => {
    // The panel re-renders on each chunk, so it sees `$`, `$$`, `$$\\fr`, … —
    // every unterminated prefix must render rather than throw and blank the
    // side panel.
    const full = "Energy:\n\n$$\n\\frac{1}{2}mv^2\n$$\n\nand \\(E=mc^2\\).";
    for (let i = 1; i <= full.length; i++) {
      expect(() => md(full.slice(0, i))).not.toThrow();
      cleanup();
    }
  });

  it("does not blow up on prose that merely contains dollar signs", () => {
    const c = md("It cost $100 and then $200 more.");
    expect(c.textContent).toContain("100");
    expect(c.textContent).toContain("200");
  });
  /**
   * The stylesheet the panel imports (`katex/dist/katex.min.css`, pulled in by
   * `src/sidepanel/index.css`) and the renderer that produces the markup (the
   * `katex` **rehype-katex** resolves — it declares `katex: ^0.16.0` as a direct
   * dependency, not a peer, so a mismatched top-level `katex` does not override
   * it but *does* change which CSS ships) must be the same KaTeX major.
   *
   * KaTeX 0.18 renamed 21 structural classes to a `katex-` prefix. A mixed pair
   * therefore ships CSS whose per-formula box model — `.base{display:inline-block;
   * position:relative;white-space:nowrap;width:min-content}` plus `.strut` —
   * matches nothing, and every sub/superscript, fraction, root and integral
   * collapses into unstyled glyphs. None of the assertions above notice: they
   * read the MathML `<annotation>` text, and happy-dom applies no CSS at all.
   *
   * So compare the two directly: take a class the renderer actually emitted and
   * require the imported stylesheet to declare a rule for it.
   */
  it("ships a stylesheet whose class names match the renderer's output", () => {
    const css = readFileSync(
      createRequire(import.meta.url).resolve("katex/dist/katex.min.css"),
      "utf8",
    );
    // The first child of `.katex-html` is the per-formula box — and it is one of
    // the classes that got renamed ("base" in 0.16, "katex-base" in 0.18), so it
    // is exactly the right probe. (Don't reach for `.katex > span`: that lands on
    // `.katex-mathml`, which carries the same name in both majors and would make
    // this test pass on a mismatched pair.)
    const boxClass = md("$x^2$").querySelector(".katex-html > span")?.className;
    expect(boxClass).toBeTruthy();
    expect(css).toContain(`.${boxClass}{`);
  });
});
