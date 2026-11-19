import { describe, expect, it, beforeEach } from "vitest";
import { extractFromDoc, extractInPage, MAX_EXTRACT_CHARS } from "./html-extract";

const HTML = `
<html><body>
  <div class="price">¥2,399</div>
  <ul class="jobs"><li>工程师 A</li><li>工程师 B</li></ul>
  <div class="wrap"><span class="sku">SKU-42</span></div>
</body></html>`;

function doc(html = HTML): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

beforeEach(() => {
  document.body.innerHTML = HTML;
});

describe("extractFromDoc (direct mode / offscreen)", () => {
  it("extracts the selector match", () => {
    expect(extractFromDoc(doc(), ".price")).toEqual({ found: true, via: "selector", text: "¥2,399" });
  });

  it("joins multiple matches one per line (list conditions)", () => {
    expect(extractFromDoc(doc(), "ul.jobs li")).toEqual({
      found: true,
      via: "selector",
      text: "工程师 A\n工程师 B",
    });
  });

  it("falls back to the text anchor when the selector is gone", () => {
    const r = extractFromDoc(doc(), ".price-renamed", "¥2,399");
    expect(r.found).toBe(true);
    expect(r.via).toBe("anchor");
    expect(r.text).toContain("¥2,399");
  });

  it("falls back to the recorded sample when there is no anchorText", () => {
    const r = extractFromDoc(doc(), "#gone", undefined, "SKU-42");
    expect(r).toMatchObject({ found: true, via: "anchor" });
    expect(r.text).toContain("SKU-42");
  });

  it("reports not-found when neither selector nor anchors match", () => {
    expect(extractFromDoc(doc(), "#gone", "nothing like this")).toEqual({
      found: false,
      via: null,
      text: "",
    });
  });

  it("caps the extracted text", () => {
    const long = `<div class="x">${"a".repeat(MAX_EXTRACT_CHARS * 2)}</div>`;
    expect(extractFromDoc(doc(long), ".x").text.length).toBe(MAX_EXTRACT_CHARS);
  });
});

describe("extractInPage (tab mode) — parity with extractFromDoc", () => {
  // The injected function is a deliberate verbatim mirror (executeScript cannot
  // import). If the two ever diverge, this test fails.
  it("produces identical results for the same document", () => {
    const cases: Array<{ selector: string; anchorText?: string; sample?: string }> = [
      { selector: ".price" },
      { selector: "ul.jobs li" },
      { selector: ".price-renamed", anchorText: "¥2,399" },
      { selector: "#gone", sample: "SKU-42" },
      { selector: "#gone", anchorText: "nothing like this" },
    ];
    for (const c of cases) {
      expect(extractInPage(c), JSON.stringify(c)).toEqual(extractFromDoc(doc(), c.selector, c.anchorText, c.sample));
    }
  });
});
