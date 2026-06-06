/**
 * injected-detect.test.ts
 *
 * Guards that the self-contained injected function (detectStructureInPage) inlines
 * the same critical logic as the canonical module sources (generate.ts, extract.ts,
 * locator.ts, columns.ts, profile.ts).
 *
 * Two test categories:
 * 1. Parity / structural assertions — inspect fnBody for critical logic strings.
 * 2. Behavioral equivalence — run both the module-level detectStructure+extractPage
 *    AND the injected detectStructureInPage on the same fixture and assert identical
 *    extraction fields + sampleRows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { detectStructureInPage } from "./injected-detect";
import { detectStructure } from "./generate";
import { extractPage } from "./extract";
import type { ExtractionSpec } from "./types";

const fnBody = detectStructureInPage.toString();

// ── Self-containment assertion ───────────────────────────────────────────────

describe("detectStructureInPage: self-containment (no import statements)", () => {
  it("fnBody does not contain runtime import statements", () => {
    // import type is erased at compile time; runtime import(...) or `import ` declarations
    // would be serialization bugs.
    // We match `import ` followed by a non-type keyword to catch runtime imports.
    // The regex avoids matching 'import type' which is the only allowed form.
    const runtimeImport = /\bimport\s+(?!type\b)/;
    expect(fnBody).not.toMatch(runtimeImport);
  });
});

// ── Structural parity assertions ──────────────────────────────────────────────

describe("detectStructureInPage parity: profile.ts", () => {
  it("inlines detectPageProfile ARIA-role check", () => {
    // esbuild compiles `'[role="grid"]'` attribute selectors using escaped quotes
    // in toString() output. We match sub-strings that survive both forms.
    expect(fnBody).toContain("role");
    expect(fnBody).toContain('"grid"');  // matches both: "grid" in attr check and the "spa-grid" string
    expect(fnBody).toContain("gridcell");
    expect(fnBody).toContain("aria-colindex");
  });

  it("inlines hashed-class ratio check", () => {
    // esbuild strips leading zero: 0.3 → .3 in compiled output
    expect(fnBody).toMatch(/[^0]\.3/);  // matches "> .3" or "> 0.3"
    expect(fnBody).toContain("spa-grid");
    expect(fnBody).toContain("classic");
  });
});

describe("detectStructureInPage parity: columns.ts", () => {
  it("inlines normalizeHeader strip-refs pattern", () => {
    // /\[[^\]]*\]/g strips [1] style refs
    expect(fnBody).toContain("normalizeHeader");
    expect(fnBody).toContain(".toLowerCase()");
    expect(fnBody).toContain("\\]]*");
  });
});

describe("detectStructureInPage parity: locator.ts", () => {
  it("inlines normText", () => {
    expect(fnBody).toContain(".replace");
    expect(fnBody).toContain(".trim()");
  });

  it("inlines selectorFor switch cases", () => {
    expect(fnBody).toContain('"testid"');
    expect(fnBody).toContain('"id"');
    expect(fnBody).toContain('"aria-label"');
    expect(fnBody).toContain('"class"');
    expect(fnBody).toContain('"nth"');
  });

  it("inlines resolveAll and resolveOne", () => {
    expect(fnBody).toContain("loc.signals");
    expect(fnBody).toContain("querySelectorAll");
    expect(fnBody).toContain("querySelector(sel)");
  });

  it("inlines matchByText and matchByRoleName", () => {
    // matchByText queries a,button,[role='button'],[role='link']
    expect(fnBody).toContain("button");
    expect(fnBody).toContain('"role+name"');
    expect(fnBody).toContain('split("|")');
  });
});

describe("detectStructureInPage parity: extract.ts", () => {
  it("inlines isAriaGrid detection", () => {
    expect(fnBody).toContain('"grid"');
    expect(fnBody).toContain('"gridcell"');
  });

  it("inlines ariaGridColMap aria-colindex support", () => {
    expect(fnBody).toContain("aria-colindex");
    expect(fnBody).toContain("columnheader");
  });

  it("inlines extractAriaCell with colIdx + 1 formula", () => {
    expect(fnBody).toContain("colIdx + 1");
    expect(fnBody).toContain('[role="gridcell"]');
  });

  it("inlines extractField column signal lookup", () => {
    expect(fnBody).toContain('"column"');
    expect(fnBody).toContain("colMap[sig.value]");
  });
});

describe("detectStructureInPage parity: generate.ts", () => {
  it("inlines repeatingGroups logic", () => {
    expect(fnBody).toContain("repeatingGroups");
    expect(fnBody).toContain("byTagClass");
    // at least 3 repeating children
    expect(fnBody).toContain(">= 3");
  });

  it("inlines rowLocatorForGroup shared-class logic", () => {
    expect(fnBody).toContain("sharedClasses");
    expect(fnBody).toContain("rowLocatorForGroup");
  });

  it("inlines ARIA-grid fast path (findAriaGridContainer)", () => {
    expect(fnBody).toContain("findAriaGridContainer");
    // The compiled fnBody uses escaped quotes in querySelector calls:
    // root.querySelector("[role=\"grid\"]") — match the unambiguous "grid" token
    expect(fnBody).toContain('"grid"');
  });
});

// ── Behavioral equivalence tests ──────────────────────────────────────────────

describe("detectStructureInPage === detectStructure + extractPage (behavioral equivalence)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /**
   * Runs both module-level (detectStructure + extractPage) and injected
   * (detectStructureInPage) on the current document and asserts identical
   * extraction fields and sample rows.
   */
  function assertDetectParity(expectedRowCount: number) {
    // Module-level detection
    const moduleDetected = detectStructure(document);
    expect(moduleDetected).not.toBeNull();
    const moduleSpec: ExtractionSpec = {
      container: moduleDetected!.container,
      rowLocator: moduleDetected!.rowLocator,
      fields: moduleDetected!.fields,
      pagination: {} as ExtractionSpec["pagination"],
      stopCondition: { maxPages: 1 },
    };
    const moduleRows = extractPage(document, moduleSpec).slice(0, 5);

    // Injected detection
    const injected = detectStructureInPage();
    expect(injected.ok).toBe(true);
    if (!injected.ok) return; // narrow type

    // Fields should be structurally equal
    expect(injected.extraction.fields).toEqual(moduleDetected!.fields);

    // rowLocator signals should be equal
    expect(injected.extraction.rowLocator).toEqual(moduleDetected!.rowLocator);

    // container should be equal
    expect(injected.extraction.container).toEqual(moduleDetected!.container);

    // sampleRows should match module extractPage output
    expect(injected.sampleRows).toEqual(moduleRows);

    // rowCount should match total rows
    expect(injected.rowCount).toBe(expectedRowCount);
  }

  it("classic list: extraction fields and sampleRows match module output", () => {
    document.body.innerHTML = `
      <ul class="items">
        <li class="item"><span class="name">Alpha</span><span class="price">£1</span></li>
        <li class="item"><span class="name">Beta</span><span class="price">£2</span></li>
        <li class="item"><span class="name">Gamma</span><span class="price">£3</span></li>
        <li class="item"><span class="name">Delta</span><span class="price">£4</span></li>
      </ul>
    `;
    assertDetectParity(4);
  });

  it("column-semantic table: extraction fields and sampleRows match module output", () => {
    document.body.innerHTML = `
      <table class="data">
        <thead>
          <tr><th>Product [1]</th><th>Price</th><th>Stock</th></tr>
        </thead>
        <tbody>
          <tr class="row"><td>Widget A</td><td>£9.99</td><td>50</td></tr>
          <tr class="row"><td>Widget B</td><td>£14.99</td><td>12</td></tr>
          <tr class="row"><td>Widget C</td><td>£4.50</td><td>200</td></tr>
        </tbody>
      </table>
    `;
    assertDetectParity(3);
  });

  it("ARIA-grid: extraction fields and sampleRows match module output", () => {
    document.body.innerHTML = `
      <div role="grid">
        <div role="row">
          <div role="columnheader" aria-colindex="1">Name</div>
          <div role="columnheader" aria-colindex="2">Score [ref]</div>
        </div>
        <div role="row">
          <div role="gridcell" aria-colindex="1">Alice</div>
          <div role="gridcell" aria-colindex="2">95</div>
        </div>
        <div role="row">
          <div role="gridcell" aria-colindex="1">Bob</div>
          <div role="gridcell" aria-colindex="2">82</div>
        </div>
        <div role="row">
          <div role="gridcell" aria-colindex="1">Carol</div>
          <div role="gridcell" aria-colindex="2">77</div>
        </div>
      </div>
    `;
    assertDetectParity(3);
  });

  it("ok=false when no repeating structure", () => {
    document.body.innerHTML = `<div><p>hi</p><p>there</p></div>`;
    const injected = detectStructureInPage();
    expect(injected.ok).toBe(false);
  });

  it("sampleRows capped at 5 even when more rows exist", () => {
    // Build 8 rows
    const rows = Array.from({ length: 8 }, (_, i) =>
      `<li class="item"><span class="name">Item${i + 1}</span></li>`,
    ).join("");
    document.body.innerHTML = `<ul class="list">${rows}</ul>`;
    const injected = detectStructureInPage();
    expect(injected.ok).toBe(true);
    if (!injected.ok) return;
    expect(injected.sampleRows.length).toBeLessThanOrEqual(5);
    expect(injected.rowCount).toBe(8);
  });
});

// ── Smoke test: result shape ───────────────────────────────────────────────────

describe("detectStructureInPage result shape", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns extraction with pagination={} and stopCondition={maxPages:1}", () => {
    document.body.innerHTML = `
      <ul class="items">
        <li class="item"><span class="n">A</span></li>
        <li class="item"><span class="n">B</span></li>
        <li class="item"><span class="n">C</span></li>
      </ul>
    `;
    const result = detectStructureInPage();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.pagination).toEqual({});
    expect(result.extraction.stopCondition).toEqual({ maxPages: 1 });
  });

  it("includes profile field", () => {
    document.body.innerHTML = `
      <ul class="items">
        <li class="item"><span class="n">A</span></li>
        <li class="item"><span class="n">B</span></li>
        <li class="item"><span class="n">C</span></li>
      </ul>
    `;
    const result = detectStructureInPage();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(["classic", "spa-grid"]).toContain(result.profile);
  });

  it("includes isTable=true for table fixture", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>A</th><th>B</th></tr></thead>
      <tbody>
        <tr class="r"><td>1</td><td>2</td></tr>
        <tr class="r"><td>3</td><td>4</td></tr>
        <tr class="r"><td>5</td><td>6</td></tr>
      </tbody></table>
    `;
    const result = detectStructureInPage();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isTable).toBe(true);
  });
});
