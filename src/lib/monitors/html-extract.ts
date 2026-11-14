// src/lib/monitors/html-extract.ts
//
// Target extraction for page monitors (§4.1 target / §4.3.3 re-locate).
//
// One canonical implementation, two runtimes:
//   - direct mode: SW fetch → offscreen DOMParser → extractFromDoc()
//   - tab mode:    chrome.scripting.executeScript(EXTRAct_IN_PAGE) — the injected
//     function must be self-contained (no imports/closures), so its body is a
//     deliberate verbatim mirror of extractFromDoc(). html-extract.test.ts
//     asserts both produce identical output on a fixture document.
//
// Locator priority: selector → anchorText (text anchor) → sample (创建时的值).
// Everything is advisory data from a third-party page; callers must wrap the
// returned text in an `untrusted_*` tag before it reaches the LLM.

export type ExtractVia = "selector" | "anchor" | "sample";

export interface ExtractResult {
  found: boolean;
  via: ExtractVia | null;
  /** Newline-joined text of every match (lists yield one line per item). */
  text: string;
}

/** Cap on extracted text — a monitor watches a value, not a whole page. */
export const MAX_EXTRACT_CHARS = 2000;

function normalize(s: string): string {
  return s.replace(/[\s ]+/g, " ").trim();
}

/**
 * Extract from a parsed document (no JS executed — this is what "direct" mode
 * sees, i.e. the server-rendered HTML).
 */
export function extractFromDoc(
  doc: Document,
  selector: string,
  anchorText?: string,
  sample?: string,
): ExtractResult {
  const nodes = Array.from(doc.querySelectorAll(selector));
  const texts = nodes
    .map((el) => normalize(el.textContent ?? ""))
    .filter((t) => t.length > 0);
  if (texts.length > 0) {
    return { found: true, via: "selector", text: texts.join("\n").slice(0, MAX_EXTRACT_CHARS) };
  }

  // Text anchor — the smallest element whose text contains the anchor string
  // (or, failing that, the recorded sample value).
  const needle = normalize(anchorText ?? "").toLowerCase() || normalize(sample ?? "").toLowerCase();
  if (needle.length === 0) return { found: false, via: null, text: "" };

  let best: string | null = null;
  for (const el of Array.from(doc.querySelectorAll("body *"))) {
    const t = normalize(el.textContent ?? "");
    if (t.length === 0) continue;
    if (!t.toLowerCase().includes(needle)) continue;
    if (best == null || t.length < best.length) best = t;
  }
  if (best == null) return { found: false, via: null, text: "" };
  return { found: true, via: "anchor", text: best.slice(0, MAX_EXTRACT_CHARS) };
}

/**
 * Tab-mode extractor — passed to chrome.scripting.executeScript as `func`.
 * MUST stay self-contained (executeScript serializes the body; imports and
 * outer-scope bindings are not available). Mirror of extractFromDoc above.
 */
export function extractInPage(args: {
  selector: string;
  anchorText?: string;
  sample?: string;
}): ExtractResult {
  const MAX = 2000;
  const norm = (s: string): string => s.replace(/[\s ]+/g, " ").trim();

  const nodes = Array.from(document.querySelectorAll(args.selector));
  const texts = nodes
    .map((el) => norm((el as HTMLElement).textContent ?? ""))
    .filter((t) => t.length > 0);
  if (texts.length > 0) {
    return { found: true, via: "selector", text: texts.join("\n").slice(0, MAX) };
  }

  const needle =
    norm(args.anchorText ?? "").toLowerCase() || norm(args.sample ?? "").toLowerCase();
  if (needle.length === 0) return { found: false, via: null, text: "" };

  let best: string | null = null;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const t = norm((el as HTMLElement).textContent ?? "");
    if (t.length === 0) continue;
    if (!t.toLowerCase().includes(needle)) continue;
    if (best == null || t.length < best.length) best = t;
  }
  if (best == null) return { found: false, via: null, text: "" };
  return { found: true, via: "anchor", text: best.slice(0, MAX) };
}
