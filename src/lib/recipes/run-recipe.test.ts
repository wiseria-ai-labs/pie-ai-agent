import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRecipe, type RunDeps, type ExtractPageResult } from "./run-recipe";
import type { Recipe } from "./recipe-types";
import type { ExtractionSpec, RecordRow } from "./types";

// ── Helpers ────────────────────────────────────────────────────────────────

const baseExtraction: ExtractionSpec = {
  container: { signals: [{ kind: "class", value: "div.container", stable: true }] },
  rowLocator: { signals: [{ kind: "class", value: "li.item", stable: true }] },
  fields: [{ name: "title", locator: { signals: [{ kind: "class", value: "span.title", stable: true }] } }],
  pagination: { mode: "url-param", urlTemplate: "https://example.com/page/{n}" },
  stopCondition: { maxPages: 10 },
};

const makeRecipe = (overrides: Partial<ExtractionSpec> = {}): Recipe => ({
  id: "recipe-1",
  name: "Test Recipe",
  createdAt: 1_000_000,
  author: "llm",
  targetUrlPattern: "https://example.com",
  extraction: { ...baseExtraction, ...overrides },
  outputSchema: [{ name: "title", type: "string" }],
});

type DepOverrides = Partial<RunDeps>;

function makePages(pages: RecordRow[][]): (tabId: number, ex: ExtractionSpec) => Promise<ExtractPageResult> {
  let call = 0;
  return async () => {
    const pageData = pages[call] ?? [];
    const hasNext = call < pages.length - 1;
    call++;
    return { records: pageData, hasNext };
  };
}

function makeDeps(overrides: DepOverrides = {}): RunDeps {
  return {
    extractOnTab: makePages([[{ title: "item1" }]]),
    navigate: vi.fn().mockResolvedValue(undefined),
    clickNext: vi.fn().mockResolvedValue(true),
    pace: vi.fn().mockResolvedValue(undefined),
    now: () => 42_000,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runRecipe — RunResult metadata", () => {
  it("returns recipeId, runAt, params, pageCount, schema", async () => {
    const deps = makeDeps();
    const result = await runRecipe(makeRecipe(), 1, { region: "us" }, deps);
    expect(result.recipeId).toBe("recipe-1");
    expect(result.runAt).toBe(42_000);
    expect(result.params).toEqual({ region: "us" });
    expect(result.schema).toEqual([{ name: "title", type: "string" }]);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
  });

  it("sourceUrl is first page URL for url-param mode", async () => {
    const deps = makeDeps();
    const result = await runRecipe(makeRecipe(), 1, {}, deps);
    expect(result.sourceUrl).toBe("https://example.com/page/1");
  });

  it("navigates to first URL before extracting (url-param mode)", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ navigate });
    await runRecipe(makeRecipe(), 99, {}, deps);
    // First navigate call should be to page 1
    expect(navigate).toHaveBeenCalledWith(99, "https://example.com/page/1");
  });
});

describe("runRecipe — multi-page accumulation", () => {
  it("accumulates rows from multiple pages", async () => {
    const pages: RecordRow[][] = [
      [{ title: "A" }, { title: "B" }],
      [{ title: "C" }],
    ];
    const deps = makeDeps({
      extractOnTab: makePages(pages),
      // stop after 2 pages
    });
    const recipe = makeRecipe({ stopCondition: { maxPages: 2 } });
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(result.records).toHaveLength(3);
    expect(result.records.map((r) => r.title)).toContain("A");
    expect(result.records.map((r) => r.title)).toContain("C");
    expect(result.pageCount).toBe(2);
  });

  it("deduplicates identical rows across pages", async () => {
    const pages: RecordRow[][] = [
      [{ title: "A" }, { title: "B" }],
      [{ title: "A" }, { title: "C" }], // A is duplicate
    ];
    const deps = makeDeps({ extractOnTab: makePages(pages) });
    const recipe = makeRecipe({ stopCondition: { maxPages: 2 } });
    const result = await runRecipe(recipe, 1, {}, deps);
    const titles = result.records.map((r) => r.title);
    expect(titles.filter((t) => t === "A")).toHaveLength(1); // deduplicated
    expect(titles).toContain("B");
    expect(titles).toContain("C");
  });
});

describe("runRecipe — stop conditions", () => {
  it("stops at maxPages", async () => {
    let callCount = 0;
    const extractOnTab = vi.fn().mockImplementation(async () => {
      callCount++;
      return { records: [{ title: `item${callCount}` }], hasNext: true };
    });
    const deps = makeDeps({ extractOnTab });
    const recipe = makeRecipe({ stopCondition: { maxPages: 3 } });
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(result.pageCount).toBe(3);
    expect(result.records).toHaveLength(3);
  });

  it("stops when untilNoNext and hasNext=false", async () => {
    const pages: RecordRow[][] = [
      [{ title: "A" }],
      [{ title: "B" }],
    ];
    // After page 2, makePages returns hasNext=false (no more pages)
    const extractOnTab = makePages(pages);
    const deps = makeDeps({ extractOnTab });
    const recipe = makeRecipe({
      pagination: { mode: "next-button" },
      stopCondition: { untilNoNext: true },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // Should stop after page 2 where hasNext becomes false
    expect(result.pageCount).toBe(2);
  });

  it("stops when untilNoNewRows and no new rows on a page", async () => {
    const rows = [{ title: "A" }, { title: "B" }];
    const pages: RecordRow[][] = [
      rows,
      rows, // same rows → no new rows after dedup
    ];
    const extractOnTab = makePages(pages);
    const deps = makeDeps({ extractOnTab });
    const recipe = makeRecipe({
      pagination: { mode: "next-button" },
      stopCondition: { untilNoNewRows: true },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // Should stop after page 2 (which has 0 new rows)
    expect(result.pageCount).toBe(2);
    expect(result.records).toHaveLength(2); // deduplicated
  });

  it("stops after one page for infinite-scroll mode when no scrollContainer dep", async () => {
    let callCount = 0;
    const extractOnTab = vi.fn().mockImplementation(async () => {
      callCount++;
      return { records: [{ title: `item${callCount}` }], hasNext: true };
    });
    const deps = makeDeps({ extractOnTab });
    const recipe = makeRecipe({
      pagination: { mode: "infinite-scroll" },
      stopCondition: { maxPages: 5 },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // No scrollContainer dep → treated as "cannot scroll" → stops after 1 page
    expect(result.pageCount).toBe(1);
  });
});

// ── G2: infinite-scroll basic virtual-scroll tests ───────────────────────────

describe("runRecipe — infinite-scroll (V1a)", () => {
  it("scrolls N times and accumulates rows, stopping when untilNoNewRows", async () => {
    // Simulate: 3 scrolls produce new rows, 4th scroll produces no new rows
    const pageBatches: RecordRow[][] = [
      [{ title: "A" }, { title: "B" }],   // initial
      [{ title: "A" }, { title: "B" }, { title: "C" }], // after scroll 1 → 1 new
      [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }], // after scroll 2 → 1 new
      [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }], // after scroll 3 → 0 new → stop
    ];
    let extractCall = 0;
    const extractOnTab = vi.fn().mockImplementation(async () => {
      const records = pageBatches[extractCall] ?? pageBatches[pageBatches.length - 1];
      extractCall++;
      return { records, hasNext: true };
    });
    let scrollCall = 0;
    const scrollContainer = vi.fn().mockImplementation(async () => {
      scrollCall++;
      return true; // always say "scrolled"
    });
    const pace = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ extractOnTab, scrollContainer, pace });
    const recipe = makeRecipe({
      pagination: { mode: "infinite-scroll" },
      stopCondition: { untilNoNewRows: true },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // 4 extract calls (initial + 3 scrolls), deduplicated to 4 unique rows
    expect(result.records).toHaveLength(4);
    expect(result.records.map((r) => r.title)).toContain("D");
    expect(scrollContainer).toHaveBeenCalled();
  });

  it("stops immediately if scrollContainer returns false (at bottom)", async () => {
    const extractOnTab = vi.fn().mockResolvedValue({ records: [{ title: "A" }], hasNext: true });
    const scrollContainer = vi.fn().mockResolvedValue(false); // already at bottom
    const deps = makeDeps({ extractOnTab, scrollContainer });
    const recipe = makeRecipe({
      pagination: { mode: "infinite-scroll" },
      stopCondition: { maxPages: 10 },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // Stops after 1 extract because scroll returned false
    expect(result.pageCount).toBe(1);
  });

  it("deduplicates rows across scroll batches", async () => {
    const pageBatches: RecordRow[][] = [
      [{ title: "A" }],
      [{ title: "A" }, { title: "B" }],
      [{ title: "A" }, { title: "B" }], // no new → stop
    ];
    let call = 0;
    const extractOnTab = vi.fn().mockImplementation(async () => {
      const records = pageBatches[call] ?? pageBatches[pageBatches.length - 1];
      call++;
      return { records, hasNext: true };
    });
    const scrollContainer = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ extractOnTab, scrollContainer });
    const recipe = makeRecipe({
      pagination: { mode: "infinite-scroll" },
      stopCondition: { untilNoNewRows: true },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // Only 2 unique rows
    expect(result.records).toHaveLength(2);
  });

});

describe("runRecipe — pace is called between pages", () => {
  it("calls pace once per inter-page transition", async () => {
    const pace = vi.fn().mockResolvedValue(undefined);
    const extractOnTab = makePages([
      [{ title: "A" }],
      [{ title: "B" }],
      [{ title: "C" }],
    ]);
    const deps = makeDeps({ extractOnTab, pace });
    const recipe = makeRecipe({ stopCondition: { maxPages: 3 } });
    await runRecipe(recipe, 1, {}, deps);
    // 3 pages means 2 transitions (after page 1 and 2, not after the last)
    expect(pace).toHaveBeenCalledTimes(2);
  });

  it("pace not called when only one page", async () => {
    const pace = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ pace });
    const recipe = makeRecipe({ stopCondition: { maxPages: 1 } });
    await runRecipe(recipe, 1, {}, deps);
    expect(pace).not.toHaveBeenCalled();
  });
});

describe("runRecipe — next-button navigation", () => {
  it("calls clickNext for next-button mode", async () => {
    const clickNext = vi.fn().mockResolvedValue(true);
    const extractOnTab = makePages([
      [{ title: "A" }],
      [{ title: "B" }],
    ]);
    const deps = makeDeps({ extractOnTab, clickNext });
    const recipe = makeRecipe({
      pagination: { mode: "next-button" },
      stopCondition: { maxPages: 2 },
    });
    await runRecipe(recipe, 1, {}, deps);
    expect(clickNext).toHaveBeenCalledWith(1, recipe.extraction);
  });

  it("stops if clickNext returns false (button not found)", async () => {
    const clickNext = vi.fn().mockResolvedValue(false);
    let callCount = 0;
    const extractOnTab = vi.fn().mockImplementation(async () => {
      callCount++;
      return { records: [{ title: `item${callCount}` }], hasNext: true };
    });
    const deps = makeDeps({ extractOnTab, clickNext });
    const recipe = makeRecipe({
      pagination: { mode: "next-button" },
      stopCondition: { maxPages: 10 },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // Should stop after page 1 because clickNext returned false
    expect(result.pageCount).toBe(1);
  });
});

describe("runRecipe — url-param navigation", () => {
  it("navigates to successive pages using urlTemplate", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const extractOnTab = makePages([
      [{ title: "A" }],
      [{ title: "B" }],
    ]);
    const deps = makeDeps({ extractOnTab, navigate });
    const recipe = makeRecipe({ stopCondition: { maxPages: 2 } });
    await runRecipe(recipe, 5, {}, deps);
    const urls = navigate.mock.calls.map(([, url]) => url as string);
    expect(urls).toContain("https://example.com/page/1");
    expect(urls).toContain("https://example.com/page/2");
  });
});
