// src/lib/recipes/params.ts

/**
 * Replaces {{name}} (or {{ name }}) placeholders in text with values from params.
 * Unknown placeholders (not present in params) are left unchanged.
 */
export function applyParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, name) =>
    name in params ? params[name] : m,
  );
}

/**
 * Merges parameter definitions (with optional defaults) and caller-supplied
 * values into a complete params map. given values override defaults; extra
 * keys in given pass through unchanged.
 */
export function resolveParams(
  defs: { name: string; default?: string }[] | undefined,
  given: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs ?? []) {
    out[d.name] = given[d.name] ?? d.default ?? "";
  }
  for (const k of Object.keys(given)) {
    out[k] = given[k];
  }
  return out;
}
