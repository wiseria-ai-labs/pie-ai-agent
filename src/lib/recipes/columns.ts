// src/lib/recipes/columns.ts
export function normalizeHeader(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\[[^\]]*\]/g, "")   // strip [1] style refs
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Maps each wanted header name to its column index (-1 if not found). */
export function mapColumns(headers: string[], wanted: string[]): Record<string, number> {
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
