// src/lib/recipes/engine.test.ts
import { describe, it, expect } from "vitest";
import { runPage, accumulate } from "./engine";
import type { ExtractionSpec } from "./types";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const spec: ExtractionSpec = {
  container: { signals: [{ kind: "class", value: "ul", stable: true }] },
  rowLocator: { signals: [{ kind: "class", value: "li.item", stable: true }] },
  fields: [{ name: "v", locator: { signals: [{ kind: "class", value: ".v", stable: true }] } }],
  pagination: { mode: "url-param", urlTemplate: "x?p={n}" },
  stopCondition: { maxPages: 5, untilNoNewRows: true },
};

describe("runPage", () => {
  it("returns records for one page", () => {
    const r = root(`<ul><li class="item"><span class="v">a</span></li><li class="item"><span class="v">b</span></li></ul>`);
    expect(runPage(r, spec)).toEqual([{ v: "a" }, { v: "b" }]);
  });
});

describe("accumulate", () => {
  it("merges pages and dedupes identical rows", () => {
    const merged = accumulate([[{ v: "a" }, { v: "b" }], [{ v: "b" }, { v: "c" }]]);
    expect(merged.rows).toEqual([{ v: "a" }, { v: "b" }, { v: "c" }]);
    expect(merged.newCountPerPage).toEqual([2, 1]);
  });
});
