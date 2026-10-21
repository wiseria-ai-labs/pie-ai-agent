import { describe, expect, it } from "vitest";
import { sanitizeInputSchema } from "./schema";

describe("sanitizeInputSchema", () => {
  it("missing / non-object schema → empty object schema", () => {
    expect(sanitizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeInputSchema("nope")).toEqual({ type: "object", properties: {} });
  });

  it("drops $schema / title / default / examples and unsupported formats", () => {
    const out = sanitizeInputSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "Args",
      properties: {
        id: { type: "string", format: "uuid", default: "x", examples: ["a"], description: "Doc id" },
        when: { type: "string", format: "date-time" },
      },
      required: ["id"],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: "Doc id" },
        when: { type: "string", format: "date-time" },
      },
      required: ["id"],
    });
  });

  it("inlines $defs/$ref and cuts recursive refs", () => {
    const out = sanitizeInputSchema({
      type: "object",
      $defs: {
        Op: { type: "object", properties: { index: { type: "integer" }, next: { $ref: "#/$defs/Op" } } },
      },
      properties: { op: { $ref: "#/$defs/Op" } },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        op: { type: "object", properties: { index: { type: "integer" }, next: {} } },
      },
    });
    expect(JSON.stringify(out)).not.toContain("$ref");
  });

  it("type arrays and `X | null` unions collapse to one type; const → enum", () => {
    const out = sanitizeInputSchema({
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "integer" }, { type: "null" }] },
        c: { const: "after" },
        d: { oneOf: [{ type: "string" }, { type: "integer" }] },
      },
    });
    expect(out.properties).toEqual({
      a: { type: "string" },
      b: { type: "integer" },
      c: { type: "string", enum: ["after"] },
      d: { anyOf: [{ type: "string" }, { type: "integer" }] },
    });
  });

  it("merges allOf objects and drops required entries that don't exist", () => {
    const out = sanitizeInputSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b", "ghost"] },
      ],
    });
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect((out.required as string[]).sort()).toEqual(["a", "b"]);
  });

  it("keeps boolean additionalProperties, drops schema-valued ones; arrays always get items", () => {
    const out = sanitizeInputSchema({
      type: "object",
      additionalProperties: false,
      properties: { m: { type: "object", additionalProperties: { type: "string" } }, list: { type: "array" } },
    });
    expect(out.additionalProperties).toBe(false);
    expect((out.properties as Record<string, unknown>).m).toEqual({ type: "object" });
    expect((out.properties as Record<string, unknown>).list).toEqual({ type: "array", items: {} });
  });

  it("drops keywords outside the provider-safe subset (Gemini 400s on unknown field names)", () => {
    const out = sanitizeInputSchema({
      type: "object",
      properties: {
        n: { type: "number", exclusiveMinimum: 0, multipleOf: 2, minimum: 1, maximum: 9, description: "count" },
        tags: { type: "array", items: { type: "string" }, uniqueItems: true, maxItems: 3 },
        s: { type: "string", "x-google-enum-descriptions": ["a"], nullable: true, pattern: "^a" },
        old: { type: "string", required: true },
      },
    });
    expect(out.properties).toEqual({
      n: { type: "number", minimum: 1, maximum: 9, description: "count" },
      tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      s: { type: "string", pattern: "^a" },
      old: { type: "string" },
    });
  });

  it("keeps only all-string enums (Gemini rejects enum on non-string types)", () => {
    const out = sanitizeInputSchema({
      type: "object",
      properties: {
        level: { type: "integer", enum: [1, 2, 3] },
        mode: { enum: ["a", "b"] },
        one: { const: 5 },
      },
    });
    expect(out.properties).toEqual({
      level: { type: "integer" },
      mode: { type: "string", enum: ["a", "b"] },
      one: {},
    });
  });

  it("top-level anyOf/oneOf is flattened into one object (Anthropic rejects root unions)", () => {
    const out = sanitizeInputSchema({
      oneOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      ],
    });
    expect(out).toEqual({
      type: "object",
      properties: { id: { type: "string" }, url: { type: "string" } },
    });
  });

  it("bounds $ref fan-out (exponential inlining cannot blow up)", () => {
    const defs: Record<string, unknown> = {};
    for (let d = 0; d < 12; d++) {
      const props: Record<string, unknown> = {};
      for (let i = 0; i < 10; i++) props[`p${i}`] = { $ref: `#/$defs/D${d + 1}` };
      defs[`D${d}`] = { type: "object", properties: props };
    }
    defs.D12 = { type: "string" };
    const out = sanitizeInputSchema({ type: "object", $defs: defs, properties: { root: { $ref: "#/$defs/D0" } } });
    expect(JSON.stringify(out).length).toBeLessThan(200_000);
  });
});
