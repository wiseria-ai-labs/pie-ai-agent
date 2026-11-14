// MCP tool input-schema sanitizer (issue #481 §5).
//
// Servers advertise arbitrary JSON Schema. Providers accept a much narrower
// subset (some reject `additionalProperties`, `$ref`, unions, type arrays…), so
// every tool schema is collapsed into a conservative, fully-inlined subset
// before it reaches the tools array:
//   - top level is always `type:"object"`
//   - `$ref` / `$defs` inlined (cycle → the tool is skipped, with a reason)
//   - `anyOf` / `oneOf` / `allOf` reduced to one conservative shape
//   - `["string","null"]`-type type arrays reduced to one type
//   - `additionalProperties` / `$schema` / `const` / `format` stripped
//   - descriptions truncated
//   - oversized or broken schemas fail this ONE tool (server keeps working)
//
// Expansion is deliberately BUDGETED: inlining a chain of `$defs` where each
// def fans out into many properties is exponential (fan^depth). The budget is
// checked as nodes are produced, so a hostile/huge schema is rejected in
// milliseconds instead of expanding to hundreds of MB inside the SW.

export const MCP_SCHEMA_MAX_BYTES = 20_000;
export const MCP_DESCRIPTION_MAX_CHARS = 1024;
export const MCP_SCHEMA_MAX_DEPTH = 8;
export const MCP_ENUM_MAX_VALUES = 100;
/** Node budget for one conversion — ≈ what fits in MCP_SCHEMA_MAX_BYTES. */
export const MCP_SCHEMA_MAX_NODES = Math.floor(MCP_SCHEMA_MAX_BYTES / 8);

/** Keywords copied through verbatim once their subtree has been converted. */
const COPY_KEYWORDS = [
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
] as const;

class SchemaError extends Error {}

export type SanitizeResult =
  | { ok: true; schema: Record<string, unknown> }
  | { ok: false; reason: string };

type Json = Record<string, unknown>;
interface Budget {
  nodes: number;
}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (!t) return undefined;
  return t.length > MCP_DESCRIPTION_MAX_CHARS
    ? t.slice(0, MCP_DESCRIPTION_MAX_CHARS) + "…"
    : t;
}

function charge(budget: Budget): void {
  budget.nodes += 1;
  if (budget.nodes > MCP_SCHEMA_MAX_NODES) {
    throw new SchemaError("input schema too large");
  }
}

function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new SchemaError(`unsupported $ref "${ref}"`);
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const part of parts) {
    if (!isObj(cur) || !(part in cur)) throw new SchemaError(`unresolvable $ref "${ref}"`);
    cur = cur[part];
  }
  return cur;
}

function convert(
  node: unknown,
  root: Json,
  depth: number,
  refStack: readonly string[],
  budget: Budget,
): Json {
  charge(budget);
  // JSON-Schema boolean schema / null: "anything" — degrade to an unconstrained
  // node instead of failing the whole tool.
  if (node === true || node === false || node === undefined || node === null) return {};
  if (!isObj(node)) throw new SchemaError("schema node is not an object");
  if (depth > MCP_SCHEMA_MAX_DEPTH) return {}; // prune deeper structure — permissive, still valid

  // 1. Inline $ref (with cycle detection).
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (refStack.includes(ref)) throw new SchemaError(`circular $ref "${ref}"`);
    const target = resolvePointer(root, ref);
    return convert(target, root, depth + 1, [...refStack, ref], budget);
  }

  // 2. Collapse unions.
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = node[key];
    if (!Array.isArray(variants) || variants.length === 0) continue;
    if (key === "allOf") {
      const merged: Json = { type: "object", properties: {}, required: [] };
      let sawObject = false;
      for (const v of variants) {
        const c = convert(v, root, depth + 1, refStack, budget);
        if (c.type !== "object") continue;
        sawObject = true;
        Object.assign(merged.properties as Json, c.properties);
        for (const r of (c.required as string[] | undefined) ?? []) {
          if (!(merged.required as string[]).includes(r)) (merged.required as string[]).push(r);
        }
        if (typeof c.description === "string" && !merged.description) merged.description = c.description;
      }
      if (sawObject) return merged;
      return convert(variants[0], root, depth + 1, refStack, budget);
    }
    // anyOf / oneOf — keep the first non-null variant (conservative).
    const first = variants.find((v) => !(isObj(v) && v.type === "null")) ?? variants[0];
    return convert(first, root, depth + 1, refStack, budget);
  }

  // 3. Type arrays (`["string","null"]`) → one type. Multiple real types →
  //    drop `type` entirely (accept anything) rather than guessing.
  let type: unknown = node.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => typeof t === "string" && t !== "null");
    type = nonNull.length === 1 ? nonNull[0] : undefined;
  }

  const out: Json = {};
  if (typeof type === "string") out.type = type;

  const description = truncate(node.description);
  if (description) out.description = description;

  if (Array.isArray(node.enum)) {
    const values = node.enum.filter(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (values.length > 0) out.enum = values.slice(0, MCP_ENUM_MAX_VALUES);
  }

  if (type === "object" || isObj(node.properties)) {
    out.type = "object";
    const props: Json = {};
    if (isObj(node.properties)) {
      for (const [k, v] of Object.entries(node.properties)) {
        props[k] = convert(v, root, depth + 1, refStack, budget);
      }
    }
    out.properties = props;
    if (Array.isArray(node.required)) {
      const required = node.required.filter((r): r is string => typeof r === "string" && r in props);
      if (required.length) out.required = required;
    }
  } else if (type === "array") {
    out.items = convert(node.items ?? {}, root, depth + 1, refStack, budget);
  }

  for (const key of COPY_KEYWORDS) {
    const v = node[key];
    if (typeof v === "number" || typeof v === "string") out[key] = v;
  }

  return out;
}

/**
 * Sanitize one tool's `inputSchema`. Never throws — a broken/oversized schema
 * returns `{ok:false, reason}` so the caller can skip just that tool.
 */
export function sanitizeInputSchema(input: unknown): SanitizeResult {
  try {
    if (input === undefined || input === null) {
      return { ok: true, schema: { type: "object", properties: {} } };
    }
    if (!isObj(input)) return { ok: false, reason: "input schema is not an object" };

    // Entry pre-check: a schema that is already over the cap is rejected before
    // any expansion work happens.
    const inputBytes = JSON.stringify(input).length;
    if (inputBytes > MCP_SCHEMA_MAX_BYTES) {
      return {
        ok: false,
        reason: `input schema too large (${inputBytes} bytes > ${MCP_SCHEMA_MAX_BYTES})`,
      };
    }

    const budget: Budget = { nodes: 0 };
    const converted = convert(input, input, 0, [], budget);
    if (converted.type === undefined && isObj(converted.properties)) converted.type = "object";
    if (converted.type !== "object") {
      return {
        ok: false,
        reason: `input schema must describe an object (got "${String(converted.type ?? "unknown")}")`,
      };
    }
    const bytes = JSON.stringify(converted).length;
    if (bytes > MCP_SCHEMA_MAX_BYTES) {
      return { ok: false, reason: `input schema too large (${bytes} bytes > ${MCP_SCHEMA_MAX_BYTES})` };
    }
    return { ok: true, schema: converted };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "invalid input schema" };
  }
}
