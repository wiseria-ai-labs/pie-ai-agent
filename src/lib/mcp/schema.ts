// MCP inputSchema → a JSON Schema subset every provider accepts.
//
// MCP servers emit full JSON Schema (often generated from zod / pydantic, with
// $defs + $ref, type arrays, const, oneOf, formats…). Gemini's function
// declarations in particular reject most of that. We normalise to the common
// subset: object/array/string/number/integer/boolean with properties,
// required, items, enum, description, anyOf, nullable-free single types.

const MAX_DEPTH = 12;

// Keys dropped outright — metadata or constructs some provider rejects.
const DROP_KEYS = new Set([
  "$schema", "$id", "$comment", "$anchor", "$dynamicAnchor", "$dynamicRef",
  "$defs", "definitions", "examples", "readOnly", "writeOnly", "deprecated",
  "contentMediaType", "contentEncoding", "if", "then", "else", "not",
  "patternProperties", "unevaluatedProperties", "unevaluatedItems",
  "dependentSchemas", "dependentRequired", "propertyNames", "additionalItems",
  "prefixItems", "contains", "minContains", "maxContains", "title", "default",
]);

// Every other key is copied through only if listed here. Anything else —
// exclusiveMinimum, multipleOf, uniqueItems, x-* vendor extensions, … — is
// dropped: Gemini parses `parameters` as a proto and 400s the WHOLE request on
// any unknown field name, which would break every turn once the server's group
// is loaded.
const PASSTHROUGH_KEYS = new Set([
  "description", "required", "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems", "pattern",
]);

// Upper bound on schema nodes emitted per tool. $ref inlining can fan out
// exponentially (N properties each referencing a def that again has N ref'd
// properties …); a hostile or merely huge server schema must not stall the
// service worker or bloat every request.
const MAX_NODES = 1_000;

// Gemini only accepts these string formats.
const KEEP_FORMATS = new Set(["date-time", "enum"]);

type Schema = Record<string, unknown>;

function isObj(v: unknown): v is Schema {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const defs = root[m[1]];
  const name = m[2].replace(/~1/g, "/").replace(/~0/g, "~");
  return isObj(defs) && isObj(defs[name]) ? (defs[name] as Schema) : undefined;
}

interface Ctx {
  root: Schema;
  nodes: number;
}

function clean(node: unknown, ctx: Ctx, depth: number, refStack: string[]): Schema {
  if (!isObj(node) || depth > MAX_DEPTH || ++ctx.nodes > MAX_NODES) return {};

  if (typeof node.$ref === "string") {
    if (refStack.includes(node.$ref)) return {}; // recursive type — cut the cycle
    const target = resolveRef(node.$ref, ctx.root);
    const merged = target ? { ...target, ...withoutKey(node, "$ref") } : withoutKey(node, "$ref");
    return clean(merged, ctx, depth + 1, [...refStack, node.$ref]);
  }

  // allOf: shallow-merge object members (the common zod/pydantic output).
  if (Array.isArray(node.allOf)) {
    let merged: Schema = withoutKey(node, "allOf");
    for (const part of node.allOf) {
      const c = clean(part, ctx, depth + 1, refStack);
      merged = {
        ...c,
        ...merged,
        properties: { ...(isObj(c.properties) ? c.properties : {}), ...(isObj(merged.properties) ? merged.properties : {}) },
        required: [...asStrings(c.required), ...asStrings(merged.required)],
      };
    }
    if (Object.keys(merged.properties as Schema).length === 0) delete merged.properties;
    if ((merged.required as string[]).length === 0) delete merged.required;
    return clean(merged, ctx, depth + 1, refStack);
  }

  const out: Schema = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) continue;
    switch (k) {
      case "type": {
        if (Array.isArray(v)) {
          const nonNull = v.filter((t) => t !== "null");
          if (nonNull.length > 0) out.type = nonNull[0];
        } else if (typeof v === "string" && v !== "null") {
          out.type = v;
        }
        break;
      }
      // Gemini accepts `enum` only on strings; non-string values are dropped
      // (the description still documents them for the model).
      case "const":
        if (typeof v === "string") out.enum = [v];
        break;
      case "enum":
        if (Array.isArray(v)) {
          const vals = v.filter((x) => x !== null);
          if (vals.length > 0 && vals.every((x) => typeof x === "string")) out.enum = vals;
        }
        break;
      case "format":
        if (typeof v === "string" && KEEP_FORMATS.has(v)) out.format = v;
        break;
      case "properties":
        if (isObj(v)) {
          const props: Schema = {};
          for (const [pk, pv] of Object.entries(v)) props[pk] = clean(pv, ctx, depth + 1, refStack);
          out.properties = props;
        }
        break;
      case "items":
        out.items = Array.isArray(v) ? clean(v[0], ctx, depth + 1, refStack) : clean(v, ctx, depth + 1, refStack);
        break;
      case "anyOf":
      case "oneOf": {
        if (!Array.isArray(v)) break;
        const opts = v
          .filter((o) => !(isObj(o) && o.type === "null"))
          .map((o) => clean(o, ctx, depth + 1, refStack));
        // `X | null` collapses to X.
        if (opts.length === 1) Object.assign(out, opts[0]);
        else if (opts.length > 1) out.anyOf = opts;
        break;
      }
      case "additionalProperties":
        // Only a boolean is safe across providers; a schema-valued one is dropped.
        if (typeof v === "boolean") out.additionalProperties = v;
        break;
      default:
        if (PASSTHROUGH_KEYS.has(k)) out[k] = v;
    }
  }
  if (out.enum && out.type === undefined && !out.anyOf) out.type = "string";

  // Infer a missing type where it is unambiguous.
  if (out.type === undefined && !out.anyOf) {
    if (out.properties) out.type = "object";
    else if (out.items) out.type = "array";
  }
  if (out.type === "array" && !out.items) out.items = {};
  if (out.required !== undefined) {
    // Non-array `required` (draft-3 per-property `required: true`) is invalid
    // JSON Schema to every provider — asStrings() yields [] and it is dropped.
    const props = isObj(out.properties) ? out.properties : {};
    const req = asStrings(out.required).filter((r) => r in props);
    if (req.length > 0) out.required = Array.from(new Set(req));
    else delete out.required;
  }
  return out;
}

function withoutKey(o: Schema, key: string): Schema {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Always returns a top-level `{type:"object", properties:{…}}` schema. */
export function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  const root = isObj(schema) ? schema : {};
  const cleaned = clean(root, { root, nodes: 0 }, 0, []);
  const properties: Schema = isObj(cleaned.properties) ? { ...cleaned.properties } : {};
  // Anthropic rejects anyOf/oneOf/allOf at the top level of input_schema
  // ("does not support oneOf, allOf, or anyOf at the top level"). A root
  // union of object variants becomes one object with every variant's
  // properties, none required.
  if (Array.isArray(cleaned.anyOf)) {
    for (const opt of cleaned.anyOf as unknown[]) {
      if (isObj(opt) && isObj(opt.properties)) {
        for (const [k, v] of Object.entries(opt.properties)) if (!(k in properties)) properties[k] = v;
      }
    }
  }
  const { anyOf: _rootUnion, ...rest } = cleaned;
  const out: Schema = { ...rest, type: "object", properties };
  if (Array.isArray(out.required)) {
    const req = asStrings(out.required).filter((r) => r in properties);
    if (req.length > 0) out.required = req;
    else delete out.required;
  }
  return out;
}
