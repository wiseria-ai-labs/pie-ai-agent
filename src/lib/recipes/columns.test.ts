// src/lib/recipes/columns.test.ts
import { describe, it, expect } from "vitest";
import { normalizeHeader, mapColumns } from "./columns";

describe("normalizeHeader", () => {
  it("collapses whitespace, strips bracket refs, lowercases", () => {
    expect(normalizeHeader("% of\nworld")).toBe("% of world");
    expect(normalizeHeader("Population[1]")).toBe("population");
    expect(normalizeHeader("  Team Name ")).toBe("team name");
  });
});

describe("mapColumns", () => {
  it("exact match by normalized header", () => {
    const m = mapColumns(["Team Name", "Year", "Wins", "Losses"], ["Team Name", "Wins"]);
    expect(m).toEqual({ "Team Name": 0, Wins: 2 });
  });

  it("falls back to contains match", () => {
    const m = mapColumns(["Source (official or from the UN)"], ["Source"]);
    expect(m.Source).toBe(0);
  });

  it("returns -1 when no column matches", () => {
    expect(mapColumns(["A", "B"], ["Z"]).Z).toBe(-1);
  });
});
