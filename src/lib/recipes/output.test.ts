// src/lib/recipes/output.test.ts
import { describe, it, expect } from "vitest";
import { toCSV, toJSON } from "./output";
import type { RunResult } from "./types";

const schema = [{ name: "team", type: "string" }, { name: "wins", type: "string" }];

describe("toCSV", () => {
  it("writes header + rows", () => {
    const csv = toCSV([{ team: "Alpha", wins: "40" }], schema);
    expect(csv).toBe("team,wins\nAlpha,40");
  });
  it("escapes commas, quotes, newlines", () => {
    const csv = toCSV([{ team: 'A,"x"', wins: "1\n2" }], schema);
    expect(csv).toBe('team,wins\n"A,""x""","1\n2"');
  });
  it("escapes carriage returns", () => {
    const csv = toCSV([{ team: "a\rb", wins: "1" }], schema);
    expect(csv).toBe('team,wins\n"a\rb",1');
  });
  it("fills missing fields with empty", () => {
    const csv = toCSV([{ team: "Alpha" }], schema);
    expect(csv).toBe("team,wins\nAlpha,");
  });
  it("header-only when no records", () => {
    expect(toCSV([], schema)).toBe("team,wins");
  });
});

describe("toJSON", () => {
  it("serializes RunResult", () => {
    const r: RunResult = {
      recipeId: "r1", runAt: 1, params: {}, sourceUrl: "u", pageCount: 1,
      schema, records: [{ team: "Alpha", wins: "40" }],
    };
    expect(JSON.parse(toJSON(r)).records[0].team).toBe("Alpha");
  });
});
