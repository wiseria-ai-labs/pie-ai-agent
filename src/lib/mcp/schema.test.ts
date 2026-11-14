import { describe, expect, it } from "vitest";
import {
  MCP_SCHEMA_MAX_BYTES,
  sanitizeInputSchema,
} from "./schema";

describe("sanitizeInputSchema", () => {
  it("forces a top-level object and drops unsupported keywords", () => {
    const r = sanitizeInputSchema({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        q: { type: "string", format: "uri", description: "query" },
        n: { type: "number", const: 3 },
      },
      required: ["q", "missing"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema.type).toBe("object");
    expect(r.schema.additionalProperties).toBeUndefined();
    expect(r.schema.$schema).toBeUndefined();
    expect(r.schema.required).toEqual(["q"]);
    const props = r.schema.properties as Record<string, Record<string, unknown>>;
    expect(props.q.format).toBeUndefined();
    expect(props.n.const).toBeUndefined();
  });

  it("inlines $ref from $defs", () => {
    const r = sanitizeInputSchema({
      type: "object",
      $defs: { Task: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      properties: { task: { $ref: "#/$defs/Task" } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const task = (r.schema.properties as Record<string, any>).task;
    expect(task.type).toBe("object");
    expect(task.properties.title.type).toBe("string");
    expect(task.required).toEqual(["title"]);
  });

  it("skips the tool on a circular $ref", () => {
    const r = sanitizeInputSchema({
      type: "object",
      $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
      properties: { root: { $ref: "#/$defs/Node" } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/circular/i);
  });

  it("skips the tool on an unresolvable $ref", () => {
    const r = sanitizeInputSchema({ type: "object", properties: { a: { $ref: "#/nope" } } });
    expect(r.ok).toBe(false);
  });

  it("collapses unions and type arrays", () => {
    const r = sanitizeInputSchema({
      type: "object",
      properties: {
        u: { anyOf: [{ type: "string" }, { type: "null" }] },
        arr: { type: ["string", "null"] },
        multi: { type: ["string", "number"] },
        all: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
          ],
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.schema.properties as Record<string, any>;
    expect(p.u.type).toBe("string");
    expect(p.arr.type).toBe("string");
    expect(p.multi.type).toBeUndefined();
    expect(p.all.type).toBe("object");
    expect(Object.keys(p.all.properties).sort()).toEqual(["a", "b"]);
  });

  it("fails when the top level is not an object", () => {
    const r = sanitizeInputSchema({ type: "string" });
    expect(r.ok).toBe(false);
  });

  it("fails oversized schemas but keeps the rest of the server usable", () => {
    const big: Record<string, unknown> = { type: "object", properties: {} };
    for (let i = 0; i < 400; i++) {
      (big.properties as Record<string, unknown>)[`p${i}`] = {
        type: "string",
        description: "x".repeat(100),
      };
    }
    const r = sanitizeInputSchema(big);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/too large/);
    expect(JSON.stringify(big).length).toBeGreaterThan(MCP_SCHEMA_MAX_BYTES);
  });

  it("accepts a missing schema as an empty object", () => {
    expect(sanitizeInputSchema(undefined)).toEqual({
      ok: true,
      schema: { type: "object", properties: {} },
    });
  });
});
