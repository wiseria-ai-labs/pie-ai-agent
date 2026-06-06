// src/lib/recipes/extract.test.ts
import { describe, it, expect } from "vitest";
import { isValidRow, extractField, extractPage, isAriaGrid, ariaGridColMap, extractAriaCell } from "./extract";
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

// ── ARIA-grid unit tests ──────────────────────────────────────────────────────

describe("isAriaGrid", () => {
  it("returns true for role=grid container", () => {
    const el = root(`<div role="grid"><div role="row"><div role="gridcell">x</div></div></div>`);
    expect(isAriaGrid(el.querySelector('[role="grid"]')!)).toBe(true);
  });
  it("returns true for a parent containing row+gridcell", () => {
    const el = root(`<div><div role="row"><div role="gridcell">x</div></div></div>`);
    expect(isAriaGrid(el.querySelector("div")!)).toBe(true);
  });
  it("returns false for a plain table", () => {
    const el = root(`<table><tr><td>x</td></tr></table>`);
    expect(isAriaGrid(el.querySelector("table")!)).toBe(false);
  });
});

describe("ariaGridColMap", () => {
  it("maps column header texts to aria-colindex (1-based → 0-based)", () => {
    const el = root(`<div role="grid">
      <div role="row">
        <div role="columnheader" aria-colindex="1">Name</div>
        <div role="columnheader" aria-colindex="2">Wins</div>
      </div>
    </div>`);
    const map = ariaGridColMap(el.querySelector('[role="grid"]')!, ["Name", "Wins"]);
    expect(map["Name"]).toBe(0);
    expect(map["Wins"]).toBe(1);
  });

  it("falls back to DOM order when aria-colindex absent", () => {
    const el = root(`<div role="grid">
      <div role="row">
        <div role="columnheader">Name</div>
        <div role="columnheader">Score</div>
      </div>
    </div>`);
    const map = ariaGridColMap(el.querySelector('[role="grid"]')!, ["Name", "Score"]);
    expect(map["Name"]).toBe(0);
    expect(map["Score"]).toBe(1);
  });
});

describe("extractAriaCell", () => {
  it("extracts cell by aria-colindex (1-based attribute)", () => {
    const row = root(`<div role="row">
      <div role="gridcell" aria-colindex="1">Alpha</div>
      <div role="gridcell" aria-colindex="2">40</div>
    </div>`).querySelector('[role="row"]')!;
    expect(extractAriaCell(row, 0)).toBe("Alpha");
    expect(extractAriaCell(row, 1)).toBe("40");
  });

  it("falls back to positional extraction when no aria-colindex on cells", () => {
    const row = root(`<div role="row">
      <div role="gridcell">Alpha</div>
      <div role="gridcell">40</div>
    </div>`).querySelector('[role="row"]')!;
    expect(extractAriaCell(row, 0)).toBe("Alpha");
    expect(extractAriaCell(row, 1)).toBe("40");
  });

  it("returns empty string for out-of-range index", () => {
    const row = root(`<div role="row">
      <div role="gridcell">Alpha</div>
    </div>`).querySelector('[role="row"]')!;
    expect(extractAriaCell(row, 5)).toBe("");
  });
});

// ── The mandatory ARIA-grid extractPage fixture ───────────────────────────────

describe("extractPage — ARIA-grid", () => {
  const ariaSpec = (extra: Partial<ExtractionSpec> = {}): ExtractionSpec => ({
    container: { signals: [{ kind: "role+name", value: "grid|", stable: false }] },
    rowLocator: { signals: [{ kind: "role+name", value: "row|", stable: false }] },
    fields: [
      { name: "name", locator: { signals: [{ kind: "column", value: "Name", stable: true }] } },
      { name: "wins", locator: { signals: [{ kind: "column", value: "Wins", stable: true }] } },
    ],
    pagination: { mode: "url-param", urlTemplate: "x?p={n}" },
    stopCondition: { maxPages: 1 },
    ...extra,
  });

  it("extracts data rows from ARIA-grid, skipping header row", () => {
    const r = root(`<div role="grid">
      <div role="row"><div role="columnheader" aria-colindex="1">Name</div><div role="columnheader" aria-colindex="2">Wins</div></div>
      <div role="row"><div role="gridcell" aria-colindex="1">Alpha</div><div role="gridcell" aria-colindex="2">40</div></div>
      <div role="row"><div role="gridcell" aria-colindex="1">Beta</div><div role="gridcell" aria-colindex="2">33</div></div>
    </div>`);
    const out = extractPage(r, ariaSpec());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "Alpha", wins: "40" });
    expect(out[1]).toMatchObject({ name: "Beta", wins: "33" });
  });

  it("handles ARIA-grid without aria-colindex (positional fallback)", () => {
    const r = root(`<div role="grid">
      <div role="row"><div role="columnheader">Name</div><div role="columnheader">Wins</div></div>
      <div role="row"><div role="gridcell">Gamma</div><div role="gridcell">27</div></div>
    </div>`);
    const out = extractPage(r, ariaSpec());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Gamma", wins: "27" });
  });

  it("skips rows that are purely header rows (containheader col)", () => {
    const r = root(`<div role="grid">
      <div role="row"><div role="columnheader">Name</div></div>
      <div role="row"><div role="gridcell">Alpha</div></div>
    </div>`);
    const out = extractPage(r, {
      ...ariaSpec(),
      fields: [{ name: "name", locator: { signals: [{ kind: "column", value: "Name", stable: true }] } }],
    });
    // Only 1 data row; header row is excluded
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Alpha" });
  });

  it("falls back to classic path for plain <table>", () => {
    const r = root(`
      <table>
        <tr><th>Team</th><th>Wins</th></tr>
        <tr class="row"><td class="name">Alpha</td><td>40</td></tr>
      </table>`);
    const spec: ExtractionSpec = {
      container: { signals: [{ kind: "class", value: "table", stable: true }] },
      rowLocator: { signals: [{ kind: "class", value: "tr.row", stable: true }] },
      fields: [
        { name: "team", locator: { signals: [{ kind: "class", value: ".name", stable: true }] } },
        { name: "wins", locator: { signals: [{ kind: "column", value: "Wins", stable: true }] } },
      ],
      pagination: { mode: "url-param", urlTemplate: "x?p={n}" },
      stopCondition: { maxPages: 1 },
    };
    const out = extractPage(r, spec);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ team: "Alpha", wins: "40" });
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

  it("drops rows missing a requireFields value but keeps the rest", () => {
    const r = root(`
      <table>
        <tr><th>Team Name</th><th>Year</th><th>Wins</th></tr>
        <tr class="team"><td class="name">Alpha</td><td>1990</td><td>40</td></tr>
        <tr class="team"><td class="name"></td><td>1991</td><td>33</td></tr>
        <tr class="team"><td class="name">Gamma</td><td>1992</td><td>27</td></tr>
      </table>`);
    const out = extractPage(r, spec());
    expect(out).toEqual([
      { team: "Alpha", wins: "40" },
      { team: "Gamma", wins: "27" },
    ]);
  });
});
