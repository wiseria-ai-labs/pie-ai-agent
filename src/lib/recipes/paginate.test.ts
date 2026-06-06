// src/lib/recipes/paginate.test.ts
import { describe, it, expect } from "vitest";
import { shouldContinue, nextUrl, resolveNext } from "./paginate";
import type { PaginationSpec } from "./types";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("shouldContinue", () => {
  it("stops at maxPages", () => {
    expect(shouldContinue({ pageCount: 3, lastPageNewRows: 5, hasNext: true }, { maxPages: 3 })).toBe(false);
    expect(shouldContinue({ pageCount: 2, lastPageNewRows: 5, hasNext: true }, { maxPages: 3 })).toBe(true);
  });
  it("stops when no new rows", () => {
    expect(shouldContinue({ pageCount: 1, lastPageNewRows: 0, hasNext: true }, { untilNoNewRows: true })).toBe(false);
  });
  it("stops when no next", () => {
    expect(shouldContinue({ pageCount: 1, lastPageNewRows: 5, hasNext: false }, { untilNoNext: true })).toBe(false);
  });
});

describe("nextUrl", () => {
  it("substitutes {n}", () => {
    expect(nextUrl("https://x/?p={n}", 4)).toBe("https://x/?p=4");
  });
});

describe("resolveNext", () => {
  it("returns null for url-param mode", () => {
    const p: PaginationSpec = { mode: "url-param", urlTemplate: "x?p={n}" };
    expect(resolveNext(root(`<a class="next">n</a>`), p)).toBeNull();
  });
  it("resolves next element for next-button mode", () => {
    const p: PaginationSpec = { mode: "next-button", next: { signals: [{ kind: "class", value: "li.next a", stable: true }] } };
    const el = resolveNext(root(`<li class="next"><a>Next</a></li>`), p);
    expect(el?.textContent).toBe("Next");
  });
});
