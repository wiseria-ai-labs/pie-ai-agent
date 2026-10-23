import { describe, it, expect } from "vitest";
import { coerceToolArgs } from "./coerce-tool-args";

const schema = {
  type: "object",
  properties: {
    tabId: { type: "integer" },
    tabIds: { type: "array", items: { type: "integer" } },
    index: { type: "integer" },
    ratio: { type: "number" },
    newTab: { type: "boolean" },
    mode: { type: "string", enum: ["a", "b"] },
    level: { type: "integer", enum: [1, 2] },
    text: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
      },
    },
    opts: { type: "object", properties: { deep: { type: "boolean" } } },
  },
};

describe("coerceToolArgs", () => {
  it("exponent-form string tabId → integer", () => {
    const r = coerceToolArgs({ tabId: "1.044214277e+09" }, schema);
    expect(r.args).toEqual({ tabId: 1044214277 });
    expect(r.coerced).toEqual(["tabId"]);
  });

  it("exponent-form float tabId (parsed number) → integer", () => {
    const r = coerceToolArgs(JSON.parse('{"tabId": 1.044214277e+09}'), schema);
    expect(r.args).toEqual({ tabId: 1044214277 });
  });

  it("near-integer float rounds; trims numeric strings", () => {
    expect(coerceToolArgs({ tabId: 1044214277.0000001 }, schema).args).toEqual({ tabId: 1044214277 });
    expect(coerceToolArgs({ index: " 12 " }, schema).args).toEqual({ index: 12 });
  });

  it("refuses non-integer floats / strings for integer", () => {
    const r = coerceToolArgs({ index: 3.5, tabId: "3.5" }, schema);
    expect(r.args).toEqual({ index: 3.5, tabId: "3.5" });
    expect(r.coerced).toEqual([]);
  });

  it("refuses garbage numeric strings", () => {
    for (const bad of ["", "12abc", "0x10", "Infinity", "NaN", "1e999"]) {
      expect(coerceToolArgs({ index: bad }, schema).args).toEqual({ index: bad });
    }
  });

  it("number from numeric string", () => {
    expect(coerceToolArgs({ ratio: "0.25" }, schema).args).toEqual({ ratio: 0.25 });
  });

  it("booleans from 'true'/'false' only", () => {
    expect(coerceToolArgs({ newTab: "true" }, schema).args).toEqual({ newTab: true });
    expect(coerceToolArgs({ newTab: " False " }, schema).args).toEqual({ newTab: false });
    expect(coerceToolArgs({ newTab: "yes" }, schema).args).toEqual({ newTab: "yes" });
    expect(coerceToolArgs({ newTab: 1 }, schema).args).toEqual({ newTab: 1 });
  });

  it("array: wraps single value, parses JSON-string array, coerces items", () => {
    expect(coerceToolArgs({ tabIds: "7" }, schema).args).toEqual({ tabIds: [7] });
    expect(coerceToolArgs({ tabIds: 7 }, schema).args).toEqual({ tabIds: [7] });
    expect(coerceToolArgs({ tabIds: "[1, \"2\"]" }, schema).args).toEqual({ tabIds: [1, 2] });
    expect(coerceToolArgs({ tabIds: ["1", 2.0000000001] }, schema).args).toEqual({ tabIds: [1, 2] });
    // single invalid item is not wrapped
    expect(coerceToolArgs({ tabIds: "abc" }, schema).args).toEqual({ tabIds: "abc" });
  });

  it("nested arrays of objects", () => {
    const r = coerceToolArgs(
      { rows: [{ id: "3", tags: "x" }, { id: 4, tags: '["a","b"]' }] },
      schema,
    );
    expect(r.args).toEqual({ rows: [{ id: 3, tags: ["x"] }, { id: 4, tags: ["a", "b"] }] });
    expect(r.coerced).toEqual(["rows[0].id", "rows[0].tags", "rows[1].tags"]);
  });

  it("object from JSON string, then recursion", () => {
    expect(coerceToolArgs({ opts: '{"deep":"true"}' }, schema).args).toEqual({ opts: { deep: true } });
  });

  it("whole args as JSON string", () => {
    const r = coerceToolArgs('{"tabId":"5","text":"hi"}', schema);
    expect(r.args).toEqual({ tabId: 5, text: "hi" });
    expect(r.coerced).toEqual(["$", "tabId"]);
  });

  it("respects enum", () => {
    expect(coerceToolArgs({ level: "2" }, schema).args).toEqual({ level: 2 });
    expect(coerceToolArgs({ level: "3" }, schema).args).toEqual({ level: "3" });
  });

  it("leaves strings, unknown keys and untyped schemas untouched; returns same reference", () => {
    const input = { text: "123", extra: "5", mode: "a", tabId: 9 };
    const r = coerceToolArgs(input, schema);
    expect(r.args).toBe(input);
    expect(r.coerced).toEqual([]);
    expect(coerceToolArgs({ x: "1" }, {}).args).toEqual({ x: "1" });
    expect(coerceToolArgs("not json", schema).args).toBe("not json");
  });

  it("does not mutate input", () => {
    const input = { tabId: "1", rows: [{ id: "2" }] };
    coerceToolArgs(input, schema);
    expect(input).toEqual({ tabId: "1", rows: [{ id: "2" }] });
  });

  it("type arrays like ['integer','null']", () => {
    const s = { type: "object", properties: { n: { type: ["integer", "null"] } } };
    expect(coerceToolArgs({ n: "4" }, s).args).toEqual({ n: 4 });
    expect(coerceToolArgs({ n: null }, s).args).toEqual({ n: null });
  });
});
