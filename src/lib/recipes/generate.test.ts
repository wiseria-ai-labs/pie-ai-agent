// src/lib/recipes/generate.test.ts
import { describe, it, expect } from "vitest";
import { generateLocator } from "./generate";

function root(html: string): HTMLElement {
  const el = document.createElement("div"); el.innerHTML = html; return el;
}

describe("generateLocator", () => {
  it("classic: leads with stable attr when present (testid)", () => {
    const r = root(`<a data-testid="more" class="btn">Next</a>`);
    const loc = generateLocator(r.querySelector("a")!, r, "classic");
    expect(loc.signals[0]).toMatchObject({ kind: "testid", stable: true });
  });

  it("classic: falls to class selector when no stable attr", () => {
    const r = root(`<article class="product_pod"><span class="price">£1</span></article>`);
    const loc = generateLocator(r.querySelector(".price")!, r, "classic");
    expect(loc.signals.some((s) => s.kind === "class")).toBe(true);
    expect(loc.signals.some((s) => s.kind === "nth")).toBe(true); // 兜底总在
  });

  it("spa-grid: prefers aria-label / role+name over hashed class", () => {
    const r = root(`<button aria-label="Next" class="css-1q8sdr">›</button>`);
    const loc = generateLocator(r.querySelector("button")!, r, "spa-grid");
    const kinds = loc.signals.map((s) => s.kind);
    expect(kinds.indexOf("aria-label")).toBeLessThan(kinds.indexOf("class") === -1 ? Infinity : kinds.indexOf("class"));
  });

  it("does NOT emit class signal for hashed classnames in spa-grid", () => {
    // Wrap in table so <td> is not stripped by the HTML parser
    const r = root(`<table><tbody><tr><td class="MuiTableCell-root css-1q8sdr">x</td></tr></tbody></table>`);
    const loc = generateLocator(r.querySelector("td")!, r, "spa-grid");
    const classSig = loc.signals.find((s) => s.kind === "class");
    // 若有 class 信号,不能包含哈希类
    if (classSig) expect(classSig.value).not.toMatch(/css-1q8sdr/);
  });

  it("text signal for actionable singletons with visible text", () => {
    const r = root(`<a class="x">Next</a>`);
    const loc = generateLocator(r.querySelector("a")!, r, "classic");
    expect(loc.signals.some((s) => s.kind === "text" && /next/i.test(s.value))).toBe(true);
  });
});

import { detectStructure } from "./generate";
import { resolveAll } from "./locator";
import { extractPage } from "./extract";

describe("detectStructure", () => {
  it("detects repeating list rows + fields", () => {
    const r = root(`<ul><li class="item"><span class="t">A</span><span class="p">1</span></li>
      <li class="item"><span class="t">B</span><span class="p">2</span></li>
      <li class="item"><span class="t">C</span><span class="p">3</span></li></ul>`);
    const s = detectStructure(r)!;
    expect(s).not.toBeNull();
    // rowLocator 解析得到 3 行
    expect(resolveAll(r, s.rowLocator).length).toBe(3);
    expect(s.fields.length).toBeGreaterThanOrEqual(2);
  });

  it("detects table with column-semantic fields", () => {
    const r = root(`<table><tr><th>Name</th><th>Wins</th></tr>
      <tr class="team"><td>Alpha</td><td>40</td></tr>
      <tr class="team"><td>Beta</td><td>33</td></tr>
      <tr class="team"><td>Gamma</td><td>27</td></tr></table>`);
    const s = detectStructure(r)!;
    expect(s.isTable).toBe(true);
    expect(s.fields.some((f) => f.locator.signals.some((sg) => sg.kind === "column"))).toBe(true);
  });

  it("returns null when no repeating structure", () => {
    expect(detectStructure(root(`<div><p>hi</p></div>`))).toBeNull();
  });

  // ── ARIA-grid detectStructure tests ────────────────────────────────────────

  it("detects ARIA-grid: produces column-semantic fields from columnheaders", () => {
    const r = root(`<div role="grid">
      <div role="row"><div role="columnheader" aria-colindex="1">Name</div><div role="columnheader" aria-colindex="2">Wins</div></div>
      <div role="row"><div role="gridcell" aria-colindex="1">Alpha</div><div role="gridcell" aria-colindex="2">40</div></div>
      <div role="row"><div role="gridcell" aria-colindex="1">Beta</div><div role="gridcell" aria-colindex="2">33</div></div>
    </div>`);
    const s = detectStructure(r)!;
    expect(s).not.toBeNull();
    // Should have column-signal fields derived from the two column headers
    expect(s.fields.some((f) => f.locator.signals.some((sg) => sg.kind === "column"))).toBe(true);
    expect(s.fields.length).toBe(2);
    // Field names normalised from header text
    expect(s.fields.map((f) => f.name)).toContain("name");
    expect(s.fields.map((f) => f.name)).toContain("wins");
  });

  it("detectStructure ARIA-grid: extractPage on detected spec yields 2 data rows", () => {
    const r = root(`<div role="grid">
      <div role="row"><div role="columnheader" aria-colindex="1">Name</div><div role="columnheader" aria-colindex="2">Wins</div></div>
      <div role="row"><div role="gridcell" aria-colindex="1">Alpha</div><div role="gridcell" aria-colindex="2">40</div></div>
      <div role="row"><div role="gridcell" aria-colindex="1">Beta</div><div role="gridcell" aria-colindex="2">33</div></div>
    </div>`);
    const s = detectStructure(r)!;
    expect(s).not.toBeNull();

    // Build a minimal ExtractionSpec from the detected structure and run extractPage
    const spec = {
      container: s.container,
      rowLocator: s.rowLocator,
      fields: s.fields,
      pagination: { mode: "url-param" as const, urlTemplate: "x?p={n}" },
      stopCondition: { maxPages: 1 },
    };
    const rows = extractPage(r, spec);
    // Should produce exactly 2 data rows (header row excluded)
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Alpha", wins: "40" });
    expect(rows[1]).toMatchObject({ name: "Beta", wins: "33" });
  });
});
