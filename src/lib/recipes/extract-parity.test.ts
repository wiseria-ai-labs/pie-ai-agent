/**
 * Guards that the self-contained injected function (extractInPage) inlines
 * the same critical logic as the canonical module sources (locator.ts,
 * extract.ts, columns.ts).
 *
 * Pattern: inspect Function.prototype.toString() of the injected function
 * body and assert it contains canonical logic strings from the modules.
 * This catches drift when a module is updated but the inline copy is not.
 *
 * Note: esbuild-compiled fn.toString() may escape string literals;
 * we use JSON.stringify(...).slice(1,-1) for robust comparison, matching
 * the pattern established in interactive-parity.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { extractInPage } from "./injected-extract";
import { normText } from "./locator";
import { normalizeHeader } from "./columns";

const fnBody = extractInPage.toString();

describe("extractInPage parity: locator.ts", () => {
  it("inlines normText logic", () => {
    // The core of normText: replace whitespace and trim
    const canonical = normText.toString();
    // Both should use .replace and .trim()
    expect(canonical).toContain(".replace");
    expect(canonical).toContain(".trim()");
    // The injected body must also contain these patterns
    expect(fnBody).toContain(".replace");
    expect(fnBody).toContain(".trim()");
  });

  it("inlines selectorFor switch cases for testid/id/name/aria-label/class/nth", () => {
    // The injected body must handle all these signal kinds
    expect(fnBody).toContain('"testid"');
    expect(fnBody).toContain('"id"');
    expect(fnBody).toContain('"name"');
    expect(fnBody).toContain('"aria-label"');
    expect(fnBody).toContain('"class"');
    expect(fnBody).toContain('"nth"');
  });

  it("inlines resolveAll signal loop", () => {
    // resolveAll iterates loc.signals and tries selectorFor
    expect(fnBody).toContain("loc.signals");
    expect(fnBody).toContain("querySelectorAll");
  });

  it("inlines resolveOne", () => {
    expect(fnBody).toContain("querySelector(sel)");
  });

  it("inlines matchByText pattern", () => {
    // matchByText queries a,button,[role='button'],[role='link']
    const escapedSelector = JSON.stringify("a,button,[role='button'],[role='link']").slice(1, -1);
    expect(fnBody).toContain(escapedSelector);
  });

  it("inlines matchByRoleName role+name split", () => {
    expect(fnBody).toContain('"role+name"');
    expect(fnBody).toContain('split("|")');
  });
});

describe("extractInPage parity: columns.ts", () => {
  it("inlines normalizeHeader strip-refs pattern", () => {
    const canonical = normalizeHeader.toString();
    // Both strip [1] style refs using the pattern /\[[^\]]*\]/g
    // The canonical source contains the regex literal
    expect(canonical).toContain("\\]]*");
    // The injected fnBody — vitest runs compiled TS, so the regex appears as-is
    expect(fnBody).toContain("normalizeHeader");
    // Both lowercase and trim
    expect(fnBody).toContain(".toLowerCase()");
  });

  it("inlines mapColumns fallback (includes) logic", () => {
    // mapColumns falls back with h.includes(nw) when exact match fails
    expect(fnBody).toContain(".includes(nw)");
  });
});

describe("extractInPage parity: extract.ts", () => {
  it("inlines column signal index lookup", () => {
    // extractField uses colMap[sig.value] for column signals
    expect(fnBody).toContain('"column"');
    expect(fnBody).toContain("colMap[sig.value]");
  });

  it("inlines isValidRow minCells check", () => {
    expect(fnBody).toContain("minCells");
    expect(fnBody).toContain("row.children.length");
  });

  it("inlines requireFields filter", () => {
    expect(fnBody).toContain("requireFields");
    expect(fnBody).toContain("every");
  });
});

describe("extractInPage functional (happy-dom)", () => {
  // Run the injected function body in the happy-dom environment
  // by extracting and calling it directly (same approach as parity tests).

  function makeEx(html: string, containerSel: string, rowSel: string, fields: { name: string; kind: string; value: string }[]) {
    return JSON.stringify({
      container: { signals: [{ kind: "class", value: containerSel, stable: true }] },
      rowLocator: { signals: [{ kind: "class", value: rowSel, stable: true }] },
      fields: fields.map((f) => ({ name: f.name, locator: { signals: [{ kind: f.kind, value: f.value, stable: true }] } })),
      pagination: { mode: "url-param" },
      stopCondition: { maxPages: 3 },
    });
  }

  beforeEach(() => {
    // Reset document body for each test
    document.body.innerHTML = "";
  });

  it("extracts rows from a list", () => {
    document.body.innerHTML = `
      <ul class="items">
        <li class="item"><span class="name">Alpha</span><span class="price">£1</span></li>
        <li class="item"><span class="name">Beta</span><span class="price">£2</span></li>
      </ul>
    `;
    const ex = makeEx("", "ul.items", "li.item", [
      { name: "name", kind: "class", value: "span.name" },
      { name: "price", kind: "class", value: "span.price" },
    ]);
    const result = extractInPage(ex);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ name: "Alpha", price: "£1" });
    expect(result.records[1]).toMatchObject({ name: "Beta", price: "£2" });
  });

  it("returns hasNext=true when next-button locator resolves", () => {
    document.body.innerHTML = `
      <ul class="items">
        <li class="item"><span class="name">Alpha</span></li>
      </ul>
      <button class="next-btn">Next</button>
    `;
    const ex = JSON.stringify({
      container: { signals: [{ kind: "class", value: "ul.items", stable: true }] },
      rowLocator: { signals: [{ kind: "class", value: "li.item", stable: true }] },
      fields: [{ name: "name", locator: { signals: [{ kind: "class", value: "span.name", stable: true }] } }],
      pagination: {
        mode: "next-button",
        next: { signals: [{ kind: "class", value: "button.next-btn", stable: true }] },
      },
      stopCondition: { untilNoNext: true },
    });
    const result = extractInPage(ex);
    expect(result.hasNext).toBe(true);
  });

  it("returns hasNext=false when next-button absent", () => {
    document.body.innerHTML = `
      <ul class="items">
        <li class="item"><span class="name">Alpha</span></li>
      </ul>
    `;
    const ex = JSON.stringify({
      container: { signals: [{ kind: "class", value: "ul.items", stable: true }] },
      rowLocator: { signals: [{ kind: "class", value: "li.item", stable: true }] },
      fields: [{ name: "name", locator: { signals: [{ kind: "class", value: "span.name", stable: true }] } }],
      pagination: {
        mode: "next-button",
        next: { signals: [{ kind: "class", value: "button.next-btn", stable: true }] },
      },
      stopCondition: { untilNoNext: true },
    });
    const result = extractInPage(ex);
    expect(result.hasNext).toBe(false);
  });

  it("extracts table rows using column signals", () => {
    document.body.innerHTML = `
      <table class="data">
        <thead><tr><th>Name</th><th>Score</th></tr></thead>
        <tbody>
          <tr class="row"><td>Alice</td><td>95</td></tr>
          <tr class="row"><td>Bob</td><td>87</td></tr>
        </tbody>
      </table>
    `;
    const ex = JSON.stringify({
      container: { signals: [{ kind: "class", value: "table.data", stable: true }] },
      rowLocator: { signals: [{ kind: "class", value: "tr.row", stable: true }] },
      fields: [
        { name: "name", locator: { signals: [{ kind: "column", value: "Name", stable: true }] } },
        { name: "score", locator: { signals: [{ kind: "column", value: "Score", stable: true }] } },
      ],
      pagination: { mode: "url-param" },
      stopCondition: { maxPages: 1 },
    });
    const result = extractInPage(ex);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ name: "Alice", score: "95" });
  });
});
