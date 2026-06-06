import { describe, it, expect } from "vitest";
import { applyParams, resolveParams } from "./params";

describe("applyParams", () => {
  it("replaces known placeholders", () => {
    expect(applyParams("p={{q}}&d={{date}}", { q: "x", date: "2026" })).toBe("p=x&d=2026");
  });

  it("preserves unknown placeholders unchanged", () => {
    expect(applyParams("hello={{z}}", { q: "x" })).toBe("hello={{z}}");
  });

  it("replaces placeholder that appears multiple times", () => {
    expect(applyParams("{{a}}-{{a}}", { a: "foo" })).toBe("foo-foo");
  });

  it("tolerates spaces inside braces: {{ q }}", () => {
    expect(applyParams("val={{ q }}", { q: "bar" })).toBe("val=bar");
  });

  it("returns text unchanged when params is empty", () => {
    expect(applyParams("no placeholders", {})).toBe("no placeholders");
  });

  it("returns empty string unchanged", () => {
    expect(applyParams("", { q: "x" })).toBe("");
  });
});

describe("resolveParams", () => {
  it("fills missing param from default", () => {
    const result = resolveParams([{ name: "q", type: "string", default: "d" }], {});
    expect(result).toEqual({ q: "d" });
  });

  it("given value overrides default", () => {
    const result = resolveParams([{ name: "q", type: "string", default: "d" }], { q: "override" });
    expect(result.q).toBe("override");
  });

  it("passes through extra given keys not in defs", () => {
    const result = resolveParams([{ name: "a", type: "string" }], { a: "1", extra: "2" });
    expect(result.extra).toBe("2");
  });

  it("param with no default and no given value resolves to empty string", () => {
    const result = resolveParams([{ name: "q", type: "string" }], {});
    expect(result.q).toBe("");
  });

  it("handles undefined defs (no parameters field)", () => {
    const result = resolveParams(undefined, { x: "1" });
    expect(result).toEqual({ x: "1" });
  });

  it("handles empty defs array", () => {
    const result = resolveParams([], { x: "1" });
    expect(result).toEqual({ x: "1" });
  });
});
