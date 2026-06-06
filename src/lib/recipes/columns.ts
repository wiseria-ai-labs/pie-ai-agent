// src/lib/recipes/columns.ts
export function normalizeHeader(s: string): string {
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
    if (idx < 0) idx = norm.findIndex((h) => h.includes(nw) || (nw.length > 0 && nw.includes(h) && h.length > 0));
    out[w] = idx;
  }
  return out;
}
