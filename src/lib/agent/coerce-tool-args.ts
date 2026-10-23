/**
 * Schema-driven tool-argument coercion.
 *
 * Weak models (e.g. qwen via Ollama) often emit tool args with the wrong JSON
 * types: `{"tabId":"1.044214277e+09"}`, `"index":"12"`, `"true"` for a
 * boolean, a bare value where an array is expected, or the whole args object
 * serialized as a string. The tool's own validation then rejects the call and
 * the model tends to spiral. This module repairs such values against the
 * tool's JSON-schema `parameters` before the handler runs.
 *
 * Rules:
 *   - Only coerce when the original value does NOT already satisfy the schema
 *     type, and only when the coerced value DOES (incl. `enum`).
 *   - Anything unknown/ambiguous is left untouched — the tool's own validation
 *     reports it.
 *   - Pure, no deps; never mutates the input.
 */

type Schema = Record<string, unknown>;

export interface CoerceResult {
  args: unknown;
  /** Paths that were coerced (e.g. `tabId`, `tabIds[0]`, `$` for root). */
  coerced: string[];
}

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INT_TOLERANCE = 1e-6;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function schemaTypes(schema: Schema): string[] {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  // Untyped schema with properties/items is conventionally an object/array.
  if (isPlainObject(schema.properties)) return ["object"];
  if (isPlainObject(schema.items)) return ["array"];
  return [];
}

function matchesType(v: unknown, type: string): boolean {
  switch (type) {
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
    case "null":
      return v === null;
    default:
      return false;
  }
}

function inEnum(v: unknown, schema: Schema): boolean {
  return !Array.isArray(schema.enum) || schema.enum.includes(v);
}

function parseNumeric(s: string): number | undefined {
  const t = s.trim();
  if (!NUMERIC_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function toInteger(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  if (Number.isInteger(n)) return Number.isSafeInteger(n) ? n : undefined;
  const r = Math.round(n);
  if (!Number.isSafeInteger(r)) return undefined;
  return Math.abs(n - r) <= INT_TOLERANCE * Math.max(1, Math.abs(r)) ? r : undefined;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const NO = Symbol("no-coercion");

/** Try to turn `v` (which does not match) into a value of `type`. */
function coerceScalar(v: unknown, type: string): unknown {
  switch (type) {
    case "integer": {
      const n = typeof v === "string" ? parseNumeric(v) : typeof v === "number" ? v : undefined;
      if (n === undefined) return NO;
      const i = toInteger(n);
      return i === undefined ? NO : i;
    }
    case "number": {
      if (typeof v !== "string") return NO;
      const n = parseNumeric(v);
      return n === undefined ? NO : n;
    }
    case "boolean": {
      if (typeof v !== "string") return NO;
      const t = v.trim().toLowerCase();
      return t === "true" ? true : t === "false" ? false : NO;
    }
    default:
      return NO;
  }
}

function walk(value: unknown, schema: unknown, path: string, out: string[]): unknown {
  if (!isPlainObject(schema)) return value;
  const types = schemaTypes(schema);
  if (types.length === 0) return value;

  // Already the right shape: recurse into containers, leave scalars alone.
  const matched = types.find((t) => matchesType(value, t));
  if (matched !== undefined) {
    if (matched === "object") return walkObject(value as Record<string, unknown>, schema, path, out);
    if (matched === "array") return walkArray(value as unknown[], schema, path, out);
    return value;
  }

  for (const type of types) {
    if (type === "object") {
      if (typeof value !== "string") continue;
      const parsed = tryParseJson(value);
      if (!isPlainObject(parsed)) continue;
      out.push(path || "$");
      return walkObject(parsed, schema, path, out);
    }
    if (type === "array") {
      const items = schema.items;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("[")) {
          const parsed = tryParseJson(trimmed);
          if (Array.isArray(parsed)) {
            out.push(path || "$");
            return walkArray(parsed, schema, path, out);
          }
        }
      }
      // Single X where [X] is expected — only when X (possibly after
      // coercion) is a valid item.
      if (isPlainObject(items) && value !== null && value !== undefined) {
        const sub: string[] = [];
        const item = walk(value, items, `${path}[0]`, sub);
        if (schemaTypes(items).some((t) => matchesType(item, t)) && inEnum(item, items)) {
          out.push(path || "$", ...sub);
          return [item];
        }
      }
      continue;
    }
    const c = coerceScalar(value, type);
    if (c !== NO && inEnum(c, schema)) {
      out.push(path || "$");
      return c;
    }
  }
  return value;
}

function walkObject(
  obj: Record<string, unknown>,
  schema: Schema,
  path: string,
  out: string[],
): Record<string, unknown> {
  const props = schema.properties;
  if (!isPlainObject(props)) return obj;
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(obj)) {
    if (!(key in props)) continue;
    const before = out.length;
    const next = walk(obj[key], props[key], path ? `${path}.${key}` : key, out);
    if (out.length !== before || next !== obj[key]) {
      copy ??= { ...obj };
      copy[key] = next;
    }
  }
  return copy ?? obj;
}

function walkArray(arr: unknown[], schema: Schema, path: string, out: string[]): unknown[] {
  const items = schema.items;
  if (!isPlainObject(items)) return arr;
  let copy: unknown[] | null = null;
  arr.forEach((el, i) => {
    const before = out.length;
    const next = walk(el, items, `${path}[${i}]`, out);
    if (out.length !== before || next !== el) {
      copy ??= [...arr];
      copy[i] = next;
    }
  });
  return copy ?? arr;
}

/**
 * Coerce `args` toward `schema` (a tool's JSON-schema `parameters`). Returns
 * the (possibly new) args and the list of coerced paths; `coerced` is empty
 * and `args` is the identical input when nothing was changed.
 */
export function coerceToolArgs(args: unknown, schema: unknown): CoerceResult {
  const coerced: string[] = [];
  if (!isPlainObject(schema)) return { args, coerced };
  const result = walk(args, schema, "", coerced);
  return { args: result, coerced };
}
