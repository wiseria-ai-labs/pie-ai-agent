// src/lib/recipes/extract.ts
import type { ExtractionSpec, FieldSpec, RecordRow, RowValidity } from "./types";
import { resolveOne, resolveAll, selectorFor, normText } from "./locator";
import { mapColumns } from "./columns";

export function isValidRow(row: Element, validity?: RowValidity): boolean {
  if (!validity) return true;
  if (validity.minCells != null && row.children.length < validity.minCells) return false;
  return true;
}

export function extractField(row: Element, f: FieldSpec, colMap: Record<string, number>): string {
  for (const sig of f.locator.signals) {
    if (sig.kind === "column") {
      const idx = colMap[sig.value];
      if (idx != null && idx >= 0) {
        const v = normText(row.children[idx]?.textContent);
        if (v) return v;
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
  const container = resolveOne(root, ex.container) ?? (root as Element);
  const scope: ParentNode = container ?? root;
  const rows = resolveAll(scope, ex.rowLocator).filter((r) => isValidRow(r, ex.rowValidity));

  let colMap: Record<string, number> = {};
  const wanted = ex.fields.flatMap((f) => f.locator.signals.filter((s) => s.kind === "column").map((s) => s.value));
  if (wanted.length) {
    const headers = [...scope.querySelectorAll("th")].map((th) => th.textContent ?? "");
    colMap = mapColumns(headers, wanted);
  }

  const req = ex.rowValidity?.requireFields;
  const out: RecordRow[] = [];
  for (const row of rows) {
    const rec: RecordRow = {};
    let any = false;
    for (const f of ex.fields) {
      rec[f.name] = extractField(row, f, colMap);
      if (rec[f.name]) any = true;
    }
    if (req && !req.every((n) => rec[n])) continue;
    if (any) out.push(rec);
  }
  return out;
}
