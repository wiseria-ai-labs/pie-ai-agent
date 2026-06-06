/**
 * injected-extract.ts
 *
 * Self-contained injected function for in-page extraction. The function body
 * is serialized by chrome.scripting.executeScript, so it MUST NOT reference
 * any imports or outer-scope closures. All helpers are inlined.
 *
 * The parity test (extract-parity.test.ts) guards that critical logic copied
 * from locator.ts / extract.ts / columns.ts stays in sync with the modules.
 */
import type { ExtractionSpec, RecordRow } from "./types";

export interface InjectedExtractResult {
  records: RecordRow[];
  hasNext: boolean;
}

/**
 * Self-contained injected function. Do NOT add imports or outer-scope
 * references here — executeScript serializes the function body.
 */
export function extractInPage(serializedExtraction: string): InjectedExtractResult {
  // ── Inline types (cannot import) ──
  type SignalKind = "testid" | "id" | "name" | "aria-label" | "role+name" | "text" | "class" | "column" | "nth";
  interface LocatorSignal { kind: SignalKind; value: string; stable: boolean }
  interface MultiSignalLocator { signals: LocatorSignal[] }
  interface FieldSpec { name: string; locator: MultiSignalLocator; attr?: string }
  interface RowValidity { minCells?: number; requireFields?: string[] }
  interface PaginationSpec {
    mode: "next-button" | "load-more" | "infinite-scroll" | "url-param";
    next?: MultiSignalLocator;
    urlTemplate?: string;
  }
  interface ExtractionSpecInline {
    container: MultiSignalLocator;
    rowLocator: MultiSignalLocator;
    fields: FieldSpec[];
    rowValidity?: RowValidity;
    pagination: PaginationSpec;
    stopCondition: { maxPages?: number; untilNoNext?: boolean; untilNoNewRows?: boolean };
  }

  // ── Inline: normText (from locator.ts) ──
  function normText(s: string | null | undefined): string {
    return (s ?? "").replace(/\s+/g, " ").trim();
  }

  // ── Inline: selectorFor (from locator.ts) ──
  function selectorFor(sig: LocatorSignal): string | null {
    switch (sig.kind) {
      case "id": return `[id="${sig.value}"]`;
      case "testid": return sig.value.startsWith("[") ? sig.value : `[data-testid="${sig.value}"]`;
      case "name": return `[name="${sig.value}"]`;
      case "aria-label": return `[aria-label="${sig.value}"]`;
      case "class": return sig.value;
      case "nth": return sig.value;
      default: return null;
    }
  }

  // ── Inline: matchByText (from locator.ts) ──
  function matchByText(root: ParentNode, text: string): Element[] {
    const want = normText(text).toLowerCase();
    if (!want) return [];
    return [...root.querySelectorAll("a,button,[role='button'],[role='link']")].filter((el) =>
      normText(el.textContent).toLowerCase().includes(want),
    );
  }

  // ── Inline: matchByRoleName (from locator.ts) ──
  function matchByRoleName(root: ParentNode, value: string): Element | null {
    const [role, name] = value.split("|");
    const want = normText(name).toLowerCase();
    const cands = [...root.querySelectorAll(`[role="${role}"], ${role}`)];
    return (
      cands.find((el) => {
        const label = normText(el.getAttribute("aria-label") || el.textContent).toLowerCase();
        return want ? label.includes(want) : true;
      }) ?? null
    );
  }

  // ── Inline: resolveAll (from locator.ts) ──
  function resolveAll(root: ParentNode, loc: MultiSignalLocator): Element[] {
    for (const sig of loc.signals) {
      const sel = selectorFor(sig);
      if (sel) {
        const els = [...root.querySelectorAll(sel)];
        if (els.length) return els;
        continue;
      }
      if (sig.kind === "text") {
        const els = matchByText(root, sig.value);
        if (els.length) return els;
      }
      if (sig.kind === "role+name") {
        const el = matchByRoleName(root, sig.value);
        if (el) return [el];
      }
    }
    return [];
  }

  // ── Inline: resolveOne (from locator.ts) ──
  function resolveOne(root: ParentNode, loc: MultiSignalLocator): Element | null {
    for (const sig of loc.signals) {
      const sel = selectorFor(sig);
      if (sel) {
        const el = root.querySelector(sel);
        if (el) return el;
        continue;
      }
      if (sig.kind === "text") {
        const el = matchByText(root, sig.value)[0];
        if (el) return el;
      }
      if (sig.kind === "role+name") {
        const el = matchByRoleName(root, sig.value);
        if (el) return el;
      }
    }
    return null;
  }

  // ── Inline: normalizeHeader (from columns.ts) ──
  function normalizeHeader(s: string | null | undefined): string {
    return (s ?? "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // ── Inline: mapColumns (from columns.ts) ──
  function mapColumns(headers: string[], wanted: string[]): Record<string, number> {
    const norm = headers.map(normalizeHeader);
    const out: Record<string, number> = {};
    for (const w of wanted) {
      const nw = normalizeHeader(w);
      let idx = norm.findIndex((h) => h === nw);
      if (idx < 0) idx = norm.findIndex((h) => h.length > 0 && h.includes(nw));
      out[w] = idx;
    }
    return out;
  }

  // ── Inline: isAriaGrid (from extract.ts) ──
  function isAriaGrid(container: ParentNode): boolean {
    const el = container as Element;
    if (el.getAttribute && el.getAttribute("role") === "grid") return true;
    const firstRow = container.querySelector('[role="row"]');
    if (firstRow && firstRow.querySelector('[role="gridcell"]')) return true;
    return false;
  }

  // ── Inline: ariaGridColMap (from extract.ts) ──
  function ariaGridColMap(container: ParentNode, wanted: string[]): Record<string, number> {
    const headers = [...container.querySelectorAll('[role="columnheader"]')];
    const headerIndices: number[] = headers.map((h, i) => {
      const col = h.getAttribute("aria-colindex");
      return col != null ? parseInt(col, 10) - 1 : i;
    });
    const normMap: Record<string, number> = {};
    headers.forEach((h, i) => {
      const t = (h.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t) normMap[t] = headerIndices[i];
    });
    const out: Record<string, number> = {};
    for (const w of wanted) {
      const nw = w.replace(/\s+/g, " ").trim().toLowerCase();
      let idx = normMap[nw] ?? -1;
      if (idx < 0) {
        const match = Object.entries(normMap).find(([k]) => k.includes(nw));
        idx = match ? match[1] : -1;
      }
      out[w] = idx;
    }
    return out;
  }

  // ── Inline: extractAriaCell (from extract.ts) ──
  function extractAriaCell(row: Element, colIdx: number): string {
    if (colIdx < 0) return "";
    const byColIndex = row.querySelector(`[role="gridcell"][aria-colindex="${colIdx + 1}"]`);
    if (byColIndex) return (byColIndex.textContent ?? "").replace(/\s+/g, " ").trim();
    const cells = [...row.querySelectorAll('[role="gridcell"]')];
    if (cells[colIdx]) return (cells[colIdx].textContent ?? "").replace(/\s+/g, " ").trim();
    return "";
  }

  // ── Inline: extractField (from extract.ts) ──
  function extractField(row: Element, f: FieldSpec, colMap: Record<string, number>, useAriaGrid = false): string {
    for (const sig of f.locator.signals) {
      if (sig.kind === "column") {
        const idx = colMap[sig.value];
        if (idx != null && idx >= 0) {
          if (useAriaGrid) {
            const v = extractAriaCell(row, idx);
            if (v) return v;
          } else {
            const v = normText(row.children[idx]?.textContent);
            if (v) return v;
          }
        }
        continue;
      }
      const sel = selectorFor(sig);
      if (sel) {
        const el = row.querySelector(sel);
        if (el) {
          const v = normText(f.attr ? el.getAttribute(f.attr) : el.textContent);
          if (v) return v;
        }
      }
    }
    return "";
  }

  // ── Inline: isValidRow (from extract.ts) ──
  function isValidRow(row: Element, validity?: RowValidity): boolean {
    if (!validity) return true;
    if (validity.minCells != null && row.children.length < validity.minCells) return false;
    return true;
  }

  // ── Main extraction logic (from extract.ts extractPage) ──
  const ex = JSON.parse(serializedExtraction) as ExtractionSpecInline;
  const root: ParentNode = document;

  const container: ParentNode = resolveOne(root, ex.container) ?? root;

  const ariaGrid = isAriaGrid(container);

  let rows: Element[];
  if (ariaGrid) {
    // ARIA-grid: data rows = [role=row] that contain gridcells (skip header rows)
    rows = [...container.querySelectorAll('[role="row"]')].filter(
      (r) =>
        r.querySelector('[role="gridcell"]') !== null &&
        !r.querySelector('[role="columnheader"]'),
    );
    rows = rows.filter((r) => isValidRow(r, ex.rowValidity));
  } else {
    rows = resolveAll(container, ex.rowLocator).filter((r) => isValidRow(r, ex.rowValidity));
  }

  let colMap: Record<string, number> = {};
  const wanted = ex.fields.flatMap((f) => f.locator.signals.filter((s) => s.kind === "column").map((s) => s.value));
  if (wanted.length) {
    if (ariaGrid) {
      colMap = ariaGridColMap(container, wanted);
    } else {
      const headers = [...container.querySelectorAll("th")].map((th) => th.textContent ?? "");
      colMap = mapColumns(headers, wanted);
    }
  }

  const req = ex.rowValidity?.requireFields;
  const records: Record<string, string>[] = [];
  for (const row of rows) {
    const rec: Record<string, string> = {};
    let any = false;
    for (const f of ex.fields) {
      rec[f.name] = extractField(row, f, colMap, ariaGrid);
      if (rec[f.name]) any = true;
    }
    if (req && !req.every((n) => rec[n])) continue;
    if (any) records.push(rec);
  }

  // Detect hasNext: check if the pagination next element exists
  const hasNext =
    ex.pagination.mode !== "url-param" && ex.pagination.next
      ? resolveOne(root, ex.pagination.next) !== null
      : false;

  return { records, hasNext };
}

/**
 * Caller wrapper: injects extractInPage into the given tab and returns results.
 * Must be called from a privileged extension context (background SW).
 */
export async function runExtractOnTab(
  tabId: number,
  extraction: ExtractionSpec,
): Promise<InjectedExtractResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractInPage,
    args: [JSON.stringify(extraction)],
  });
  // executeScript returns an array of frame results; take the main frame
  const result = results[0]?.result as InjectedExtractResult | undefined;
  return result ?? { records: [], hasNext: false };
}
