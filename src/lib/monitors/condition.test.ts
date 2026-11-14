import { describe, expect, it } from "vitest";
import {
  addedItems,
  evaluateCondition,
  parseNumber,
  splitItems,
} from "./condition";

describe("parseNumber", () => {
  it("handles currency prefixes, thousands separators and units", () => {
    expect(parseNumber("¥1,999")).toBe(1999);
    expect(parseNumber("$2 399.50")).toBe(2399.5);
    expect(parseNumber("价格 1,299 元")).toBe(1299);
    expect(parseNumber("-12.5°C")).toBe(-12.5);
  });

  it("returns null when there is no number", () => {
    expect(parseNumber("sold out")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
});

describe("splitItems", () => {
  it("splits and trims newline-joined list values", () => {
    expect(splitItems("a\n b \n\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("evaluateCondition — changed", () => {
  it("treats the first check as a baseline, never a trigger", () => {
    expect(evaluateCondition({ kind: "changed" }, undefined, "v1")).toEqual({ ok: true, met: false });
  });

  it("triggers on any difference from the previous value", () => {
    expect(evaluateCondition({ kind: "changed" }, "v1", "v2")).toEqual({ ok: true, met: true });
    expect(evaluateCondition({ kind: "changed" }, "v1", "v1")).toEqual({ ok: true, met: false });
  });
});

describe("evaluateCondition — number", () => {
  it("compares below / above", () => {
    expect(evaluateCondition({ kind: "number", op: "lt", value: 2000 }, "¥2,199", "¥1,999")).toEqual({
      ok: true,
      met: true,
    });
    expect(evaluateCondition({ kind: "number", op: "lt", value: 2000 }, "¥2,199", "¥2,199")).toEqual({
      ok: true,
      met: false,
    });
    expect(evaluateCondition({ kind: "number", op: "gt", value: 100 }, "0", "101")).toEqual({
      ok: true,
      met: true,
    });
  });

  it("reports ok:false (a failure, not a miss) when no number can be parsed", () => {
    const r = evaluateCondition({ kind: "number", op: "lt", value: 2000 }, "1999", "sold out");
    expect(r.ok).toBe(false);
  });
});

describe("evaluateCondition — contains", () => {
  it("is case-insensitive and trims the needle", () => {
    expect(
      evaluateCondition({ kind: "contains", text: "  Available " }, undefined, "slots AVAILABLE now"),
    ).toEqual({ ok: true, met: true });
  });

  it("rejects an empty needle", () => {
    expect(evaluateCondition({ kind: "contains", text: "   " }, undefined, "x").ok).toBe(false);
  });
});

describe("evaluateCondition — list_added", () => {
  it("baselines on the first check", () => {
    expect(evaluateCondition({ kind: "list_added" }, undefined, "a\nb")).toEqual({
      ok: true,
      met: false,
    });
  });

  it("triggers only when an item is new", () => {
    expect(evaluateCondition({ kind: "list_added" }, "a\nb", "a\nb")).toEqual({ ok: true, met: false });
    expect(evaluateCondition({ kind: "list_added" }, "a\nb", "a\nb\nc")).toEqual({ ok: true, met: true });
    // A removal is not a "new item" — it must not fire.
    expect(evaluateCondition({ kind: "list_added" }, "a\nb", "b")).toEqual({ ok: true, met: false });
  });

  it("fails when the list comes back empty", () => {
    expect(evaluateCondition({ kind: "list_added" }, "a", "").ok).toBe(false);
  });
});

describe("addedItems", () => {
  it("returns only the new rows", () => {
    expect(addedItems("a\nb", "a\nb\nc\nd")).toEqual(["c", "d"]);
  });
});
