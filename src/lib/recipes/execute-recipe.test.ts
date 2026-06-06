// src/lib/recipes/execute-recipe.test.ts
import { describe, it, expect, vi } from "vitest";
import { executeRecipe, type ExecuteRecipeDeps, type RecipeStore, type Downloader } from "./execute-recipe";
import type { Recipe } from "./recipe-types";
import type { ExtractPageResult } from "./run-recipe";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseExtraction = {
  container: { signals: [{ kind: "class" as const, value: "div.list", stable: true }] },
  rowLocator: { signals: [{ kind: "class" as const, value: "li.row", stable: true }] },
  fields: [
    { name: "title", locator: { signals: [{ kind: "class" as const, value: "span.title", stable: true }] } },
    { name: "price", locator: { signals: [{ kind: "class" as const, value: "span.price", stable: true }] } },
  ],
  pagination: { mode: "url-param" as const, urlTemplate: "https://example.com/page/{n}" },
  stopCondition: { maxPages: 2 },
};

const testRecipe: Recipe = {
  id: "r-test-1",
  name: "Test Recipe",
  createdAt: 1_700_000_000_000,
  author: "llm",
  targetUrlPattern: "https://example.com",
  extraction: baseExtraction,
  outputSchema: [
    { name: "title", type: "string" },
    { name: "price", type: "string" },
  ],
};

function makeStore(recipe: Recipe | null): RecipeStore {
  return {
    getRecipe: vi.fn().mockResolvedValue(recipe),
  };
}

function makeRunDeps(pages: Array<Array<Record<string, string>>> = [[{ title: "Item A", price: "£5" }]]) {
  let call = 0;
  const extractOnTab = vi.fn().mockImplementation(
    async (): Promise<ExtractPageResult> => {
      const pageData = pages[call] ?? [];
      const hasNext = call < pages.length - 1;
      call++;
      return { records: pageData, hasNext };
    }
  );

  return {
    extractOnTab,
    navigate: vi.fn().mockResolvedValue(undefined),
    clickNext: vi.fn().mockResolvedValue(false),
    pace: vi.fn().mockResolvedValue(undefined),
    now: () => 1_700_000_000_000,
  };
}

function makeDownloader(): Downloader & { calls: Array<{ filename: string; content: string; mime: string }> } {
  const calls: Array<{ filename: string; content: string; mime: string }> = [];
  return {
    calls,
    download: vi.fn().mockImplementation(async (filename: string, content: string, mime: string) => {
      calls.push({ filename, content, mime });
    }),
  };
}

function makeDeps(overrides: Partial<ExecuteRecipeDeps> = {}): ExecuteRecipeDeps {
  return {
    store: makeStore(testRecipe),
    runDeps: makeRunDeps(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeRecipe — orchestration", () => {
  it("calls getRecipe with the given id", async () => {
    const store = makeStore(testRecipe);
    const deps = makeDeps({ store });
    await executeRecipe("r-test-1", 42, {}, deps);
    expect(store.getRecipe).toHaveBeenCalledWith("r-test-1");
  });

  it("throws when recipe not found", async () => {
    const deps = makeDeps({ store: makeStore(null) });
    await expect(executeRecipe("missing", 42, {}, deps)).rejects.toThrow(
      /recipe "missing" not found/,
    );
  });

  it("returns rows from the extraction", async () => {
    const runDeps = makeRunDeps([[{ title: "Book A", price: "£9.99" }]]);
    const deps = makeDeps({ runDeps });
    const result = await executeRecipe("r-test-1", 42, {}, deps);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ title: "Book A", price: "£9.99" });
  });

  it("returns runResult with recipeId metadata", async () => {
    const deps = makeDeps();
    const result = await executeRecipe("r-test-1", 42, { region: "uk" }, deps);
    expect(result.runResult.recipeId).toBe("r-test-1");
    expect(result.runResult.params).toEqual({ region: "uk" });
  });

  it("passes tabId to extractOnTab", async () => {
    const runDeps = makeRunDeps();
    const deps = makeDeps({ runDeps });
    await executeRecipe("r-test-1", 99, {}, deps);
    expect(runDeps.extractOnTab).toHaveBeenCalledWith(99, expect.anything());
  });

  it("returns empty files array when no downloader provided", async () => {
    const deps = makeDeps();
    const result = await executeRecipe("r-test-1", 42, {}, deps);
    expect(result.files).toEqual([]);
  });

  it("downloads CSV and JSON when downloader is provided", async () => {
    const dl = makeDownloader();
    const runDeps = makeRunDeps([[{ title: "Book A", price: "£5" }]]);
    const deps = makeDeps({ runDeps, downloader: dl });
    const result = await executeRecipe("r-test-1", 42, {}, deps);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatch(/\.csv$/);
    expect(result.files[1]).toMatch(/\.json$/);
    expect(dl.download).toHaveBeenCalledTimes(2);
  });

  it("CSV download uses text/csv MIME type", async () => {
    const dl = makeDownloader();
    const deps = makeDeps({ downloader: dl });
    await executeRecipe("r-test-1", 42, {}, deps);
    const csvCall = dl.calls.find((c) => c.filename.endsWith(".csv"));
    expect(csvCall?.mime).toBe("text/csv");
  });

  it("JSON download uses application/json MIME type", async () => {
    const dl = makeDownloader();
    const deps = makeDeps({ downloader: dl });
    await executeRecipe("r-test-1", 42, {}, deps);
    const jsonCall = dl.calls.find((c) => c.filename.endsWith(".json"));
    expect(jsonCall?.mime).toBe("application/json");
  });

  it("CSV content has correct header row", async () => {
    const dl = makeDownloader();
    const runDeps = makeRunDeps([[{ title: "Book A", price: "£5" }]]);
    const deps = makeDeps({ runDeps, downloader: dl });
    await executeRecipe("r-test-1", 42, {}, deps);
    const csvCall = dl.calls.find((c) => c.filename.endsWith(".csv"));
    expect(csvCall?.content).toMatch(/^title,price/);
  });

  it("JSON content is valid JSON with records array", async () => {
    const dl = makeDownloader();
    const runDeps = makeRunDeps([[{ title: "Book A", price: "£5" }]]);
    const deps = makeDeps({ runDeps, downloader: dl });
    await executeRecipe("r-test-1", 42, {}, deps);
    const jsonCall = dl.calls.find((c) => c.filename.endsWith(".json"));
    const parsed = JSON.parse(jsonCall?.content ?? "{}");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({ title: "Book A" });
  });

  it("file names are sanitized (no special chars)", async () => {
    const recipeWithSpecialName: Recipe = {
      ...testRecipe,
      name: "Price/Data: Report (2024)",
    };
    const dl = makeDownloader();
    const deps = makeDeps({
      store: makeStore(recipeWithSpecialName),
      downloader: dl,
    });
    await executeRecipe("r-test-1", 42, {}, deps);
    for (const filename of result_filenames(dl)) {
      expect(filename).toMatch(/^recipe_[a-zA-Z0-9_-]+_\d{4}-\d{2}-\d{2}/);
    }
  });

  it("multi-page: pace is called between pages", async () => {
    // Two pages: stop after page 1 naturally (url-param mode navigates to page 2)
    const runDeps = makeRunDeps([
      [{ title: "A", price: "1" }],
      [{ title: "B", price: "2" }],
    ]);
    const deps = makeDeps({ runDeps });
    const result = await executeRecipe("r-test-1", 42, {}, deps);
    // Should have run, results accumulated
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(runDeps.pace).toHaveBeenCalled();
  });
});

// Helper for the file name test
function result_filenames(dl: ReturnType<typeof makeDownloader>): string[] {
  return dl.calls.map((c) => c.filename);
}
