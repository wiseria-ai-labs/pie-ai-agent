// src/lib/recipes/extract.ts
import type { ExtractionSpec, FieldSpec, RecordRow, RowValidity } from "./types";
import { resolveOne, resolveAll, selectorFor, normText } from "./locator";
import { mapColumns, normalizeHeader } from "./columns";

/**
 * Structural pre-check only: validates `minCells` (cell count) on a candidate
 * row. It does NOT enforce `requireFields` — that is a post-extraction filter
 * applied in `extractPage` after fields have been read (a row can have enough
 * cells yet still lack a required field's value).
 */
export function isValidRow(row: Element, validity?: RowValidity): boolean {
  if (!validity) return true;
  if (validity.minCells != null && row.children.length < validity.minCells) return false;
  return true;
}

// ── ARIA-grid helpers ────────────────────────────────────────────────────────

/**
 * Detect whether the given container uses ARIA-grid semantics
 * (role=grid, or rows containing gridcells).
 */
export function isAriaGrid(container: ParentNode): boolean {
  const el = container as Element;
  if (el.getAttribute && el.getAttribute("role") === "grid") return true;
  const firstRow = container.querySelector('[role="row"]');
  if (firstRow && firstRow.querySelector('[role="gridcell"]')) return true;
  return false;
}

/**
 * Build a column-index map from ARIA columnheader elements.
 * Priority: aria-colindex attribute (1-based → converted to 0-based).
 * Fallback: DOM order.
 */
export function ariaGridColMap(container: ParentNode, wanted: string[]): Record<string, number> {
  // Find all columnheader elements (may be nested in a row)
  const headers = [...container.querySelectorAll('[role="columnheader"]')];
  const headerIndices: number[] = headers.map((h, i) => {
    // aria-colindex is 1-based; fall back to DOM order (0-based)
    const col = h.getAttribute("aria-colindex");
    return col != null ? parseInt(col, 10) - 1 : i;
  });

  // Build a lookup: normalised text → 0-based index (uses normalizeHeader for [ref] stripping)
  const normMap: Record<string, number> = {};
  headers.forEach((h, i) => {
    const t = normalizeHeader(h.textContent);
    if (t) normMap[t] = headerIndices[i];
  });

  const out: Record<string, number> = {};
  for (const w of wanted) {
    const nw = normalizeHeader(w);
    let idx = normMap[nw] ?? -1;
    if (idx < 0) {
      // fuzzy: find first header text that contains the wanted string
      const match = Object.entries(normMap).find(([k]) => k.includes(nw));
      idx = match ? match[1] : -1;
    }
    out[w] = idx;
  }
  return out;
}

/**
 * Extract a cell value from an ARIA-grid row.
 * Matches [role=gridcell][aria-colindex="N"] when colindex is known;
 * falls back to positional child if no aria-colindex on cells.
 */
export function extractAriaCell(row: Element, colIdx: number): string {
  if (colIdx < 0) return "";
  // Try aria-colindex match first (1-based in the attribute)
  const byColIndex = row.querySelector(`[role="gridcell"][aria-colindex="${colIdx + 1}"]`);
  if (byColIndex) return (byColIndex.textContent ?? "").replace(/\s+/g, " ").trim();
  // Fall back to positional child (filter to only gridcell children)
  const cells = [...row.querySelectorAll('[role="gridcell"]')];
  if (cells[colIdx]) return (cells[colIdx].textContent ?? "").replace(/\s+/g, " ").trim();
  return "";
}

// ── extractField ─────────────────────────────────────────────────────────────

export function extractField(
  row: Element,
  f: FieldSpec,
  colMap: Record<string, number>,
  useAriaGrid = false,
): string {
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

export function extractPage(root: ParentNode, ex: ExtractionSpec): RecordRow[] {
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
  const out: RecordRow[] = [];
  for (const row of rows) {
    const rec: RecordRow = {};
    let any = false;
    for (const f of ex.fields) {
      rec[f.name] = extractField(row, f, colMap, ariaGrid);
      if (rec[f.name]) any = true;
    }
    if (req && !req.every((n) => rec[n])) continue;
    if (any) out.push(rec);
  }
  return out;
}
