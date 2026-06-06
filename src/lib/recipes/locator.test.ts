// src/lib/recipes/locator.test.ts
import { describe, it, expect } from "vitest";
import { resolveOne, resolveAll, normText } from "./locator";
import type { MultiSignalLocator } from "./types";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("normText", () => {
  it("collapses whitespace and trims", () => {
    expect(normText("  a\n  b  ")).toBe("a b");
    expect(normText(null)).toBe("");
  });
});

describe("resolveAll", () => {
  it("uses first hitting signal (class) and returns all matches", () => {
    const r = root(`<article class="card"></article><article class="card"></article>`);
    const loc: MultiSignalLocator = { signals: [{ kind: "class", value: "article.card", stable: true }] };
    expect(resolveAll(r, loc).length).toBe(2);
  });

  it("falls through to next signal when first misses", () => {
    const r = root(`<table><tbody><tr class="team"></tr></tbody></table>`);
    const loc: MultiSignalLocator = {
      signals: [
        { kind: "testid", value: '[data-testid="row"]', stable: true },
        { kind: "class", value: "tr.team", stable: true },
      ],
    };
    expect(resolveAll(r, loc).length).toBe(1);
  });
});

describe("resolveOne", () => {
  it("resolves by id via attribute selector", () => {
    const r = root(`<a id="more">next</a>`);
    expect(resolveOne(r, { signals: [{ kind: "id", value: "more", stable: true }] })?.textContent).toBe("next");
  });

  it("resolves singleton by text (icon-less next link)", () => {
    const r = root(`<a class="x">Next</a><a>Prev</a>`);
    const el = resolveOne(r, { signals: [{ kind: "text", value: "next", stable: false }] });
    expect(el?.textContent).toBe("Next");
  });

  it("resolves by aria-label (icon next button)", () => {
    const r = root(`<a aria-label="Next">›</a>`);
    const el = resolveOne(r, { signals: [{ kind: "aria-label", value: "Next", stable: true }] });
    expect(el?.getAttribute("aria-label")).toBe("Next");
  });

  it("resolves by role+name", () => {
    const r = root(`<div role="button" aria-label="Submit">x</div>`);
    const el = resolveOne(r, { signals: [{ kind: "role+name", value: "button|submit", stable: false }] });
    expect(el?.getAttribute("aria-label")).toBe("Submit");
  });
});
