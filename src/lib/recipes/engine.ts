// src/lib/recipes/engine.ts
import type { ExtractionSpec, RecordRow } from "./types";
import { extractPage } from "./extract";

export function runPage(root: ParentNode, ex: ExtractionSpec): RecordRow[] {
  return extractPage(root, ex);
}

export interface AccumulateResult {
  rows: RecordRow[];
  newCountPerPage: number[];
}

/** Merges per-page records, dropping rows already seen (supports untilNoNewRows). */
export function accumulate(pages: RecordRow[][]): AccumulateResult {
  const seen = new Set<string>();
  const rows: RecordRow[] = [];
  const newCountPerPage: number[] = [];
  for (const page of pages) {
    let fresh = 0;
    for (const row of page) {
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh++;
    }
    newCountPerPage.push(fresh);
  }
  return { rows, newCountPerPage };
}
