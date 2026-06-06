import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRecipe, type RunDeps, type ExtractPageResult } from "./run-recipe";
import type { Recipe } from "./recipe-types";
import type { ActionStep } from "./recipe-types";
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

// ── I3: missing next locator guard ───────────────────────────────────────────

describe("runRecipe — I3: missing next locator guard", () => {
  it("warns when next-button mode has no next locator", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    const recipe = makeRecipe({
      // next-button but deliberately no `next` locator
      pagination: { mode: "next-button" },
      stopCondition: { maxPages: 1 },
    });
    await runRecipe(recipe, 1, {}, deps);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("next-button/load-more pagination without a next locator"),
    );
    warnSpy.mockRestore();
  });

  it("warns when load-more mode has no next locator", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    const recipe = makeRecipe({
      pagination: { mode: "load-more" },
      stopCondition: { maxPages: 1 },
    });
    await runRecipe(recipe, 1, {}, deps);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("next-button/load-more pagination without a next locator"),
    );
    warnSpy.mockRestore();
  });

  it("does NOT warn when next-button mode has a next locator defined", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    const recipe = makeRecipe({
      pagination: {
        mode: "next-button",
        next: { signals: [{ kind: "class", value: "button.next", stable: true }] },
      },
      stopCondition: { maxPages: 1 },
    });
    await runRecipe(recipe, 1, {}, deps);
    const relevantWarns = warnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("next locator"),
    );
    expect(relevantWarns).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("extracts only the first page and does not loop infinitely when next locator missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;
    const extractOnTab = vi.fn().mockImplementation(async () => {
      callCount++;
      return { records: [{ title: `item${callCount}` }], hasNext: true };
    });
    const clickNext = vi.fn().mockResolvedValue(false); // button not found
    const deps = makeDeps({ extractOnTab, clickNext });
    const recipe = makeRecipe({
      pagination: { mode: "next-button" }, // no `next` locator
      stopCondition: { maxPages: 100 }, // high cap — we expect early stop
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    // clickNext returns false → loop exits after first page
    expect(result.pageCount).toBe(1);
    warnSpy.mockRestore();
  });
});

// ── I2: incremental accumulation perf correctness ────────────────────────────

describe("runRecipe — I2: incremental accumulation", () => {
  it("deduplicates correctly across many pages (matches bulk accumulate semantics)", async () => {
    // Build pages where row sets overlap — incremental and bulk must agree
    const pages: RecordRow[][] = [
      [{ id: "1" }, { id: "2" }],
      [{ id: "2" }, { id: "3" }],   // id:2 is duplicate
      [{ id: "3" }, { id: "4" }],   // id:3 is duplicate
      [{ id: "5" }],
    ];
    const deps = makeDeps({ extractOnTab: makePages(pages) });
    const recipe = makeRecipe({ stopCondition: { maxPages: 4 } });
    const result = await runRecipe(recipe, 1, {}, deps);
    // unique rows: 1,2,3,4,5
    expect(result.records).toHaveLength(5);
    const ids = result.records.map((r) => r.id).sort();
    expect(ids).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.pageCount).toBe(4);
  });

  it("stops on untilNoNewRows with incremental dedup (same behaviour as before)", async () => {
    const rows = [{ title: "A" }, { title: "B" }];
    const pages: RecordRow[][] = [
      rows,
      rows, // no new rows → stop
    ];
    const deps = makeDeps({ extractOnTab: makePages(pages) });
    const recipe = makeRecipe({
      pagination: { mode: "next-button" },
      stopCondition: { untilNoNewRows: true },
    });
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(result.pageCount).toBe(2);
    expect(result.records).toHaveLength(2);
  });
});

// ── Guard: missing pagination / stopCondition ─────────────────────────────────
// LLM may omit pagination (or stopCondition) for single-page recipes.
// runRecipe must not throw TypeError and must return after the first page.

/** Build a recipe where pagination is missing at the JS level (simulates LLM omission). */
function makeRecipeNoPagination(): Recipe {
  const ex = { ...baseExtraction } as Record<string, unknown>;
  delete ex["pagination"];
  return {
    id: "recipe-np",
    name: "No Pagination Recipe",
    createdAt: 1_000_000,
    author: "llm",
    targetUrlPattern: "https://example.com",
    extraction: ex as unknown as ExtractionSpec,
    outputSchema: [{ name: "title", type: "string" }],
  };
}

/** Build a recipe where stopCondition is missing at the JS level. */
function makeRecipeNoStopCondition(): Recipe {
  const ex = { ...baseExtraction } as Record<string, unknown>;
  delete ex["stopCondition"];
  return {
    id: "recipe-nsc",
    name: "No StopCondition Recipe",
    createdAt: 1_000_000,
    author: "llm",
    targetUrlPattern: "https://example.com",
    extraction: ex as unknown as ExtractionSpec,
    outputSchema: [{ name: "title", type: "string" }],
  };
}

describe("runRecipe — guard: missing pagination", () => {
  it("does not throw when pagination is absent (treats as single-page)", async () => {
    const extractOnTab = vi.fn().mockResolvedValue({ records: [{ title: "X" }], hasNext: false });
    const deps = makeDeps({ extractOnTab });
    const recipe = makeRecipeNoPagination();
    // Must not throw
    const result = await runRecipe(recipe, 1, {}, deps);
    // Falls through to else-break (unknown mode) → stops after first page
    expect(result.pageCount).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].title).toBe("X");
  });

  it("sourceUrl is empty when pagination.urlTemplate is absent", async () => {
    const deps = makeDeps();
    const recipe = makeRecipeNoPagination();
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(result.sourceUrl).toBe("");
  });
});

describe("runRecipe — guard: missing stopCondition", () => {
  it("does not throw when stopCondition is absent (HARD_MAX_PAGES acts as cap)", async () => {
    const extractOnTab = vi.fn().mockResolvedValue({ records: [{ title: "Y" }], hasNext: false });
    const deps = makeDeps({ extractOnTab });
    const recipe = makeRecipeNoStopCondition();
    // Must not throw — shouldContinue returns false after HARD_MAX_PAGES or hasNext=false
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.records).toHaveLength(1);
  });
});

// ── V1b: actionPrelude replay ─────────────────────────────────────────────────

describe("runRecipe — actionPrelude replay (V1b)", () => {
  const preludeSteps: ActionStep[] = [
    {
      type: "navigate",
      url: "https://example.com/login",
    },
    {
      type: "type",
      locator: { signals: [{ kind: "class", value: "[name=email]", stable: true }] },
      value: "user@example.com",
    },
  ];

  it("calls runAction once per prelude step in order", async () => {
    const runAction = vi.fn().mockResolvedValue(undefined);
    const pace = vi.fn().mockResolvedValue(undefined);
    const recipe: Recipe = {
      ...makeRecipe(),
      actionPrelude: preludeSteps,
    };
    const deps = makeDeps({ runAction, pace });
    await runRecipe(recipe, 7, {}, deps);
    expect(runAction).toHaveBeenCalledTimes(2);
    // First call: navigate step
    expect(runAction.mock.calls[0][1].type).toBe("navigate");
    // Second call: type step
    expect(runAction.mock.calls[1][1].type).toBe("type");
    // All calls use the correct tabId
    expect(runAction.mock.calls[0][0]).toBe(7);
    expect(runAction.mock.calls[1][0]).toBe(7);
  });

  it("pace is called after each prelude step", async () => {
    const runAction = vi.fn().mockResolvedValue(undefined);
    const pace = vi.fn().mockResolvedValue(undefined);
    const recipe: Recipe = {
      ...makeRecipe({ stopCondition: { maxPages: 1 } }),
      actionPrelude: preludeSteps,
    };
    const deps = makeDeps({ runAction, pace });
    await runRecipe(recipe, 1, {}, deps);
    // pace called: once per prelude step (2) + 0 inter-page (only 1 page)
    // Total pace calls = 2 prelude steps
    const preludePaceCalls = pace.mock.calls.length;
    expect(preludePaceCalls).toBeGreaterThanOrEqual(2);
  });

  it("applies parameter substitution in prelude step values and urls", async () => {
    const runAction = vi.fn().mockResolvedValue(undefined);
    const stepsWithParams: ActionStep[] = [
      { type: "navigate", url: "https://example.com/search?q={{query}}" },
      {
        type: "type",
        locator: { signals: [{ kind: "class", value: "[name=q]", stable: true }] },
        value: "{{query}}",
      },
    ];
    const recipe: Recipe = {
      ...makeRecipe({ stopCondition: { maxPages: 1 } }),
      actionPrelude: stepsWithParams,
      parameters: [{ name: "query", type: "string", default: "default-q" }],
    };
    const deps = makeDeps({ runAction });
    await runRecipe(recipe, 1, { query: "hello" }, deps);

    // First call: navigate with substituted url
    const navigateStep = runAction.mock.calls[0][1] as ActionStep;
    expect(navigateStep.url).toBe("https://example.com/search?q=hello");
    // Second call: type with substituted value
    const typeStep = runAction.mock.calls[1][1] as ActionStep;
    expect(typeStep.value).toBe("hello");
  });

  it("uses parameter defaults when no given values", async () => {
    const runAction = vi.fn().mockResolvedValue(undefined);
    const stepsWithParams: ActionStep[] = [
      { type: "navigate", url: "https://example.com/search?q={{query}}" },
    ];
    const recipe: Recipe = {
      ...makeRecipe({ stopCondition: { maxPages: 1 } }),
      actionPrelude: stepsWithParams,
      parameters: [{ name: "query", type: "string", default: "default-val" }],
    };
    const deps = makeDeps({ runAction });
    // Pass empty params — should use default
    await runRecipe(recipe, 1, {}, deps);
    const navigateStep = runAction.mock.calls[0][1] as ActionStep;
    expect(navigateStep.url).toBe("https://example.com/search?q=default-val");
  });

  it("prelude steps are replayed BEFORE the first extract call", async () => {
    const callOrder: string[] = [];
    const runAction = vi.fn().mockImplementation(async () => {
      callOrder.push("runAction");
    });
    const extractOnTab = vi.fn().mockImplementation(async () => {
      callOrder.push("extract");
      return { records: [{ title: "A" }], hasNext: false };
    });
    const recipe: Recipe = {
      ...makeRecipe({ stopCondition: { maxPages: 1 } }),
      actionPrelude: [{ type: "click", locator: { signals: [{ kind: "class", value: ".btn", stable: true }] } }],
    };
    const deps = makeDeps({ runAction, extractOnTab });
    await runRecipe(recipe, 1, {}, deps);
    const runIdx = callOrder.indexOf("runAction");
    const extractIdx = callOrder.indexOf("extract");
    expect(runIdx).toBeLessThan(extractIdx);
  });

  it("no prelude: runAction is never called and behaviour is unchanged", async () => {
    const runAction = vi.fn().mockResolvedValue(undefined);
    const recipe = makeRecipe({ stopCondition: { maxPages: 1 } });
    // no actionPrelude field
    const deps = makeDeps({ runAction });
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(runAction).not.toHaveBeenCalled();
    expect(result.pageCount).toBe(1);
    expect(result.records).toHaveLength(1);
  });

  it("empty actionPrelude: runAction is never called", async () => {
    const runAction = vi.fn().mockResolvedValue(undefined);
    const recipe: Recipe = {
      ...makeRecipe({ stopCondition: { maxPages: 1 } }),
      actionPrelude: [],
    };
    const deps = makeDeps({ runAction });
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(runAction).not.toHaveBeenCalled();
    expect(result.pageCount).toBe(1);
  });

  it("without runAction dep, prelude is silently skipped (no crash)", async () => {
    const recipe: Recipe = {
      ...makeRecipe({ stopCondition: { maxPages: 1 } }),
      actionPrelude: preludeSteps,
    };
    // No runAction dep
    const deps = makeDeps();
    // Must not throw
    const result = await runRecipe(recipe, 1, {}, deps);
    expect(result.pageCount).toBe(1);
  });
});
