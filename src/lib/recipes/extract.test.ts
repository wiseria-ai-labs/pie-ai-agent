// src/lib/recipes/extract.test.ts
import { describe, it, expect } from "vitest";
import { isValidRow, extractField, extractPage } from "./extract";
import type { ExtractionSpec, FieldSpec } from "./types";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("isValidRow", () => {
  it("rejects rows with too few cells", () => {
    const r = root(`<table><tr><td>only</td></tr></table>`).querySelector("tr")!;
    expect(isValidRow(r, { minCells: 3 })).toBe(false);
  });
  it("accepts when no validity given", () => {
    const r = root(`<table><tr><td>a</td></tr></table>`).querySelector("tr")!;
    expect(isValidRow(r, undefined)).toBe(true);
  });
});

describe("extractField", () => {
  it("structural class selector relative to row", () => {
    const row = root(`<article><span class="price">£10</span></article>`).querySelector("article")!;
    const f: FieldSpec = { name: "price", locator: { signals: [{ kind: "class", value: ".price", stable: true }] } };
    expect(extractField(row, f, {})).toBe("£10");
  });
  it("reads attribute when attr set", () => {
    const row = root(`<div><a class="t" title="Hello">x</a></div>`).querySelector("div")!;
    const f: FieldSpec = { name: "t", attr: "title", locator: { signals: [{ kind: "class", value: ".t", stable: true }] } };
    expect(extractField(row, f, {})).toBe("Hello");
  });
  it("column-semantic via colMap", () => {
    const row = root(`<table><tr><td>A</td><td>B</td><td>C</td></tr></table>`).querySelector("tr")!;
    const f: FieldSpec = { name: "wins", locator: { signals: [{ kind: "column", value: "Wins", stable: true }] } };
    expect(extractField(row, f, { Wins: 2 })).toBe("C");
  });
});

describe("extractPage", () => {
  const spec = (extra: Partial<ExtractionSpec> = {}): ExtractionSpec => ({
    container: { signals: [{ kind: "class", value: "table", stable: true }] },
    rowLocator: { signals: [{ kind: "class", value: "tr.team", stable: true }] },
    fields: [
      { name: "team", locator: { signals: [{ kind: "class", value: ".name", stable: true }] } },
      { name: "wins", locator: { signals: [{ kind: "column", value: "Wins", stable: true }] } },
    ],
    rowValidity: { requireFields: ["team"] },
    pagination: { mode: "url-param", urlTemplate: "x?p={n}" },
    stopCondition: { maxPages: 3 },
    ...extra,
  });

  it("extracts records and skips invalid rows", () => {
    const r = root(`
      <table>
        <tr><th>Team Name</th><th>Year</th><th>Wins</th></tr>
        <tr class="team"><td class="name">Alpha</td><td>1990</td><td>40</td></tr>
        <tr class="team"><td class="name">Beta</td><td>1991</td><td>33</td></tr>
        <tr class="team"><td class="name"></td><td></td><td></td></tr>
      </table>`);
    const out = extractPage(r, spec());
    expect(out).toEqual([
      { team: "Alpha", wins: "40" },
      { team: "Beta", wins: "33" },
    ]);
  });
});
