// src/lib/agent/tools/recipe.ts
//
// LLM-facing recipe tools:
//   save_recipe — persists a new Recipe to IndexedDB (write-class)
//   run_recipe  — runs an existing recipe on the current active tab (write-class)
//
// Both are WRITE-CLASS tools (see tool-names.ts classification rationale):
//   - save_recipe mutates IndexedDB (creates a new persistent Recipe)
//   - run_recipe  navigates / injects into a live tab and writes files to Downloads
//
// Dep injection pattern (mirrors skill-meta.ts):
//   - buildRecipeTools(deps) is the testable factory used in unit tests
//   - RECIPE_TOOLS is the production singleton wired to real chrome/IDB deps
//     and appended to BUILT_IN_TOOLS in tools.ts

import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { ExtractionSpec } from "../../recipes/types";
import type { Recipe } from "../../recipes/recipe-types";
import type { ExecuteRecipeDeps } from "../../recipes/execute-recipe";

// ── Dep injection types for testability ───────────────────────────────────────

export interface RecipeToolDeps {
  /** Persist a recipe. Defaults to recipe-store putRecipe in production. */
  putRecipe: (recipe: Recipe) => Promise<void>;
  /**
   * Execute a recipe. Receives the tabId from the ToolHandlerContext.
   * Defaults to executeRecipe(recipeId, tabId, params, buildExecDeps()) in production.
   */
  executeRecipe: (
    recipeId: string,
    tabId: number,
    params: Record<string, string>,
    deps: ExecuteRecipeDeps,
  ) => Promise<{ rows: unknown[]; files: string[] }>;
  /** Build production ExecuteRecipeDeps for run_recipe. */
  buildExecDeps: () => ExecuteRecipeDeps;
}

// ── ID generation ─────────────────────────────────────────────────────────────

function generateRecipeId(): string {
  return `recipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── save_recipe args ──────────────────────────────────────────────────────────

interface SaveRecipeArgs {
  name?: unknown;
  targetUrlPattern?: unknown;
  extraction?: unknown;
  outputSchema?: unknown;
}

// ── run_recipe args ───────────────────────────────────────────────────────────

interface RunRecipeArgs {
  recipeId?: unknown;
  params?: unknown;
}

// ── Tool factory (dep-injected, used in tests and for production singleton) ───

export function buildRecipeTools(deps: RecipeToolDeps): Tool[] {
  const saveRecipeTool: Tool = {
    name: "save_recipe",
    description:
      "Save a data-extraction recipe for later reuse. " +
      "A recipe captures: the target URL pattern, the extraction specification " +
      "(container/row/field locators + pagination + stop condition), and the output schema. " +
      "After saving, run it via run_recipe.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "targetUrlPattern", "extraction"],
      properties: {
        name: {
          type: "string",
          description: "Short human-readable label for this recipe.",
        },
        targetUrlPattern: {
          type: "string",
          description:
            "Glob or substring matched against the tab URL at run time. " +
            "Example: 'books.toscrape.com' or 'https://example.com/products/*'.",
        },
        extraction: {
          type: "object",
          description:
            "The full ExtractionSpec: container (MultiSignalLocator), " +
            "rowLocator (MultiSignalLocator), fields (FieldSpec[]), " +
            "rowValidity?, pagination (PaginationSpec), stopCondition (StopCondition).",
        },
        outputSchema: {
          type: "array",
          description:
            "Column definitions: [{name: string, type: string}]. " +
            "Defaults to one entry per field in extraction.fields if omitted.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
            },
            required: ["name", "type"],
            additionalProperties: false,
          },
        },
      },
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as SaveRecipeArgs;

      if (typeof a.name !== "string" || !a.name.trim()) {
        return { success: false, error: "name is required (non-empty string)" };
      }
      if (typeof a.targetUrlPattern !== "string" || !a.targetUrlPattern.trim()) {
        return { success: false, error: "targetUrlPattern is required (non-empty string)" };
      }
      if (!a.extraction || typeof a.extraction !== "object") {
        return { success: false, error: "extraction is required (object)" };
      }

      // Guard: LLM may omit pagination/stopCondition for single-page recipes.
      // Normalise them to empty objects here so malformed data never enters the store.
      const rawExtraction = a.extraction as Record<string, unknown>;
      const extraction: ExtractionSpec = {
        ...(rawExtraction as unknown as ExtractionSpec),
        pagination: (rawExtraction.pagination ?? {}) as ExtractionSpec["pagination"],
        stopCondition: (rawExtraction.stopCondition ?? {}) as ExtractionSpec["stopCondition"],
      };

      // Derive output schema from fields if not explicitly provided
      const outputSchema: { name: string; type: string }[] = Array.isArray(a.outputSchema)
        ? (a.outputSchema as { name: string; type: string }[])
        : (extraction.fields ?? []).map((f: { name: string }) => ({
            name: f.name,
            type: "string",
          }));

      const recipe: Recipe = {
        id: generateRecipeId(),
        name: a.name.trim(),
        createdAt: Date.now(),
        author: "llm",
        targetUrlPattern: a.targetUrlPattern.trim(),
        extraction,
        outputSchema,
      };

      try {
        await deps.putRecipe(recipe);
      } catch (e) {
        return {
          success: false,
          error: `Failed to save recipe: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      return {
        success: true,
        observation:
          `Recipe saved: id=${recipe.id} name="${recipe.name}". ` +
          `Run it via run_recipe with recipeId="${recipe.id}".`,
      };
    },
  };

  const runRecipeTool: Tool = {
    name: "run_recipe",
    description:
      "Run a saved recipe on the current active tab. " +
      "Injects the extraction logic, paginates through all pages, " +
      "and saves results as CSV + JSON to the user's Downloads folder. " +
      "Returns a summary of the run (row count, page count, filenames).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["recipeId"],
      properties: {
        recipeId: {
          type: "string",
          description: "The id of the recipe to run (returned by save_recipe).",
        },
        params: {
          type: "object",
          description: "Optional runtime parameters (e.g. URL substitutions).",
          additionalProperties: { type: "string" },
        },
      },
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as RunRecipeArgs;

      if (typeof a.recipeId !== "string" || !a.recipeId.trim()) {
        return { success: false, error: "recipeId is required (non-empty string)" };
      }

      const params: Record<string, string> =
        a.params && typeof a.params === "object" && !Array.isArray(a.params)
          ? (a.params as Record<string, string>)
          : {};

      const execDeps = deps.buildExecDeps();

      let result: { rows: unknown[]; files: string[] };
      try {
        result = await deps.executeRecipe(a.recipeId.trim(), ctx.tabId, params, execDeps);
      } catch (e) {
        return {
          success: false,
          error: `Recipe run failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      const filesNote =
        result.files.length > 0
          ? `\nFiles saved to Downloads: ${result.files.map((f) => `pie/${f}`).join(", ")}`
          : "";

      return {
        success: true,
        observation:
          `Recipe run complete. Rows extracted: ${result.rows.length}.${filesNote}`,
      };
    },
  };

  return [saveRecipeTool, runRecipeTool];
}
// Note: canonical tool name lists live in tool-names.ts — do not re-export them here.
