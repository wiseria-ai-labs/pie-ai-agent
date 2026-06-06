// src/lib/agent/tools/recipe.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRecipeTools, type RecipeToolDeps } from "./recipe";
import type { Recipe } from "../../recipes/recipe-types";
import type { ExecuteRecipeDeps } from "../../recipes/execute-recipe";
import type { ToolHandlerContext } from "../types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const minimalExtractionJson = {
  container: { signals: [{ kind: "class", value: "div.list", stable: true }] },
  rowLocator: { signals: [{ kind: "class", value: "li.row", stable: true }] },
  fields: [
    { name: "title", locator: { signals: [{ kind: "class", value: "span.title", stable: true }] } },
  ],
  pagination: { mode: "url-param", urlTemplate: "https://example.com/page/{n}" },
  stopCondition: { maxPages: 5 },
};

/** Minimal ctx with a tabId for run_recipe handler. */
const ctx42 = { tabId: 42 } as ToolHandlerContext;

function makeDeps(overrides: Partial<RecipeToolDeps> = {}): RecipeToolDeps {
  return {
    putRecipe: vi.fn().mockResolvedValue(undefined),
    executeRecipe: vi.fn().mockResolvedValue({ rows: [{ title: "A" }], files: ["a.csv", "a.json"] }),
    buildExecDeps: vi.fn().mockReturnValue({} as ExecuteRecipeDeps),
    ...overrides,
  };
}

// ── save_recipe tests ─────────────────────────────────────────────────────────

describe("save_recipe", () => {
  let deps: RecipeToolDeps;
  let saveRecipe: ReturnType<typeof buildRecipeTools>[0];

  beforeEach(() => {
    deps = makeDeps();
    const tools = buildRecipeTools(deps);
    saveRecipe = tools.find((t) => t.name === "save_recipe")!;
  });

  it("rejects missing name", async () => {
    const r = await saveRecipe.handler({ targetUrlPattern: "x", extraction: minimalExtractionJson }, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/name/);
  });

  it("rejects empty name", async () => {
    const r = await saveRecipe.handler({ name: "  ", targetUrlPattern: "x", extraction: minimalExtractionJson }, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/name/);
  });

  it("rejects missing targetUrlPattern", async () => {
    const r = await saveRecipe.handler({ name: "Test", extraction: minimalExtractionJson }, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/targetUrlPattern/);
  });

  it("rejects missing extraction", async () => {
    const r = await saveRecipe.handler({ name: "Test", targetUrlPattern: "x.com" }, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/extraction/);
  });

  it("calls putRecipe with correct structure", async () => {
    const r = await saveRecipe.handler(
      { name: "My Recipe", targetUrlPattern: "example.com", extraction: minimalExtractionJson },
      ctx42,
    );
    expect(r.success).toBe(true);
    expect(deps.putRecipe).toHaveBeenCalledTimes(1);
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.name).toBe("My Recipe");
    expect(saved.author).toBe("llm");
    expect(saved.targetUrlPattern).toBe("example.com");
    expect(saved.id).toMatch(/^recipe_/);
  });

  it("derives outputSchema from fields when not provided", async () => {
    await saveRecipe.handler(
      { name: "Auto Schema", targetUrlPattern: "x.com", extraction: minimalExtractionJson },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.outputSchema).toEqual([{ name: "title", type: "string" }]);
  });

  it("uses provided outputSchema when given", async () => {
    await saveRecipe.handler(
      {
        name: "Manual Schema",
        targetUrlPattern: "x.com",
        extraction: minimalExtractionJson,
        outputSchema: [{ name: "title", type: "text" }, { name: "price", type: "number" }],
      },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.outputSchema).toEqual([
      { name: "title", type: "text" },
      { name: "price", type: "number" },
    ]);
  });

  it("observation includes recipe id and name", async () => {
    const r = await saveRecipe.handler(
      { name: "Report", targetUrlPattern: "site.com", extraction: minimalExtractionJson },
      ctx42,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("Report");
    expect(r.observation).toContain("run_recipe");
  });

  it("forwards putRecipe failure as error", async () => {
    deps.putRecipe = vi.fn().mockRejectedValue(new Error("IDB quota exceeded"));
    const tools = buildRecipeTools(deps);
    const s = tools.find((t) => t.name === "save_recipe")!;
    const r = await s.handler(
      { name: "Fail", targetUrlPattern: "x", extraction: minimalExtractionJson },
      ctx42,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("IDB quota exceeded");
  });
});

// ── run_recipe tests ──────────────────────────────────────────────────────────

describe("run_recipe", () => {
  let deps: RecipeToolDeps;
  let runRecipeTool: ReturnType<typeof buildRecipeTools>[0];

  beforeEach(() => {
    deps = makeDeps();
    const tools = buildRecipeTools(deps);
    runRecipeTool = tools.find((t) => t.name === "run_recipe")!;
  });

  it("rejects missing recipeId", async () => {
    const r = await runRecipeTool.handler({}, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/recipeId/);
  });

  it("rejects empty recipeId", async () => {
    const r = await runRecipeTool.handler({ recipeId: "  " }, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/recipeId/);
  });

  it("calls executeRecipe with tabId from ctx", async () => {
    const r = await runRecipeTool.handler({ recipeId: "recipe_123", params: { region: "uk" } }, ctx42);
    expect(r.success).toBe(true);
    expect(deps.executeRecipe).toHaveBeenCalledWith(
      "recipe_123",
      42,  // ctx.tabId
      { region: "uk" },
      expect.anything(),
    );
  });

  it("observation includes row count", async () => {
    deps.executeRecipe = vi.fn().mockResolvedValue({ rows: new Array(7).fill({}), files: [] });
    const tools = buildRecipeTools(deps);
    const r2 = tools.find((t) => t.name === "run_recipe")!;
    const r = await r2.handler({ recipeId: "r1" }, ctx42);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("7");
  });

  it("observation lists downloaded files", async () => {
    const r = await runRecipeTool.handler({ recipeId: "r1" }, ctx42);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("a.csv");
    expect(r.observation).toContain("a.json");
  });

  it("forwards executeRecipe failure as error", async () => {
    deps.executeRecipe = vi.fn().mockRejectedValue(new Error("recipe not found"));
    const tools = buildRecipeTools(deps);
    const r2 = tools.find((t) => t.name === "run_recipe")!;
    const r = await r2.handler({ recipeId: "r1" }, ctx42);
    expect(r.success).toBe(false);
    expect(r.error).toContain("recipe not found");
  });

  it("treats missing params as empty object", async () => {
    await runRecipeTool.handler({ recipeId: "r1" }, ctx42);
    expect(deps.executeRecipe).toHaveBeenCalledWith(
      "r1",
      42,
      {},
      expect.anything(),
    );
  });

  it("calls buildExecDeps to construct dependencies", async () => {
    await runRecipeTool.handler({ recipeId: "r1" }, ctx42);
    expect(deps.buildExecDeps).toHaveBeenCalled();
  });

  it("no files note when files array is empty", async () => {
    deps.executeRecipe = vi.fn().mockResolvedValue({ rows: [{}], files: [] });
    const tools = buildRecipeTools(deps);
    const r2 = tools.find((t) => t.name === "run_recipe")!;
    const r = await r2.handler({ recipeId: "r1" }, ctx42);
    expect(r.success).toBe(true);
    expect(r.observation).not.toContain("Downloads");
  });
});

// ── save_recipe: actionPrelude + parameters (V1b/V1c) ────────────────────────

describe("save_recipe — actionPrelude and parameters (V1b/V1c)", () => {
  let deps: RecipeToolDeps;
  let saveRecipe: ReturnType<typeof buildRecipeTools>[0];

  beforeEach(() => {
    deps = makeDeps();
    const tools = buildRecipeTools(deps);
    saveRecipe = tools.find((t) => t.name === "save_recipe")!;
  });

  it("stores actionPrelude when provided", async () => {
    const prelude = [
      { type: "navigate", url: "https://example.com/login" },
      { type: "type", locator: { signals: [{ kind: "id", value: "email", stable: true }] }, value: "user@example.com" },
    ];
    await saveRecipe.handler(
      { name: "Prelude Recipe", targetUrlPattern: "example.com", extraction: minimalExtractionJson, actionPrelude: prelude },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.actionPrelude).toHaveLength(2);
    expect(saved.actionPrelude![0]).toMatchObject({ type: "navigate", url: "https://example.com/login" });
    expect(saved.actionPrelude![1]).toMatchObject({ type: "type" });
  });

  it("stores parameters when provided", async () => {
    const parameters = [
      { name: "query", type: "string", default: "default-q" },
      { name: "region", type: "string" },
    ];
    await saveRecipe.handler(
      { name: "Param Recipe", targetUrlPattern: "example.com", extraction: minimalExtractionJson, parameters },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.parameters).toHaveLength(2);
    expect(saved.parameters![0]).toMatchObject({ name: "query", default: "default-q" });
    expect(saved.parameters![1]).toMatchObject({ name: "region" });
  });

  it("stores both actionPrelude and parameters together", async () => {
    const prelude = [{ type: "navigate", url: "https://example.com/search?q={{query}}" }];
    const parameters = [{ name: "query", type: "string", default: "test" }];
    await saveRecipe.handler(
      {
        name: "Full Recipe", targetUrlPattern: "example.com",
        extraction: minimalExtractionJson, actionPrelude: prelude, parameters,
      },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.actionPrelude).toHaveLength(1);
    expect(saved.parameters).toHaveLength(1);
  });

  it("omits actionPrelude when not provided (backward-compat)", async () => {
    await saveRecipe.handler(
      { name: "No Prelude", targetUrlPattern: "example.com", extraction: minimalExtractionJson },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.actionPrelude).toBeUndefined();
  });

  it("omits parameters when not provided (backward-compat)", async () => {
    await saveRecipe.handler(
      { name: "No Params", targetUrlPattern: "example.com", extraction: minimalExtractionJson },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.parameters).toBeUndefined();
  });

  it("omits actionPrelude when provided as empty array", async () => {
    await saveRecipe.handler(
      { name: "Empty Prelude", targetUrlPattern: "example.com", extraction: minimalExtractionJson, actionPrelude: [] },
      ctx42,
    );
    const saved = (deps.putRecipe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Recipe;
    expect(saved.actionPrelude).toBeUndefined();
  });
});

// ── tool list shape ───────────────────────────────────────────────────────────

describe("buildRecipeTools", () => {
  it("returns exactly 2 tools: save_recipe and run_recipe", () => {
    const tools = buildRecipeTools(makeDeps());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["run_recipe", "save_recipe"]);
  });
});
