// src/lib/agent/tools/recipe.ts
//
// LLM-facing recipe tools:
//   detect_recipe_structure — deterministic structure detection (read-class)
//   save_recipe             — persists a new Recipe to IndexedDB (write-class)
//   run_recipe              — runs an existing recipe on the current active tab (write-class)
//
// detect_recipe_structure is READ-CLASS: it only injects a read-only function
//   into the page and returns observations; no DOM/tab mutation.
// save_recipe and run_recipe are WRITE-CLASS (see tool-names.ts):
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
import type { Recipe, ActionStep, RecipeParam } from "../../recipes/recipe-types";
import type { ExecuteRecipeDeps } from "../../recipes/execute-recipe";
import type { InjectedDetectOutput } from "../../recipes/injected-detect";

// ── Dep injection types for testability ───────────────────────────────────────

export interface RecipeToolDeps {
  /**
   * Run deterministic structure detection in the given tab.
   * Defaults to detectStructureOnTab in production.
   */
  detectStructure: (tabId: number) => Promise<InjectedDetectOutput>;
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
  /** V1b: ordered pre-extraction action steps (click/type/navigate/select/submit). */
  actionPrelude?: unknown;
  /** V1c: named parameter definitions for actionPrelude placeholder substitution. */
  parameters?: unknown;
}

// ── run_recipe args ───────────────────────────────────────────────────────────

interface RunRecipeArgs {
  recipeId?: unknown;
  params?: unknown;
}

// ── Tool factory (dep-injected, used in tests and for production singleton) ───

export function buildRecipeTools(deps: RecipeToolDeps): Tool[] {
  const detectRecipeStructureTool: Tool = {
    name: "detect_recipe_structure",
    description:
      "Deterministically detect the repeating data structure on the current page " +
      "and return a ready-to-use ExtractionSpec (container, rowLocator, fields) " +
      "together with up to 5 sample rows. " +
      "Always call this BEFORE save_recipe — do NOT hand-write locators. " +
      "If ok=false the page has no detectable structure; ask the user to navigate " +
      "to a page with a list or table.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    handler: async (_args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      let result: InjectedDetectOutput;
      try {
        result = await deps.detectStructure(ctx.tabId);
      } catch (e) {
        return {
          success: false,
          error: `detect_recipe_structure failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      if (!result.ok) {
        return {
          success: true,
          observation:
            "ok=false — no repeating structure detected on this page. " +
            "Navigate to a page with a list or table and call detect_recipe_structure again. " +
            "Do NOT call save_recipe with hand-written locators.",
        };
      }

      const { profile, isTable, rowCount, extraction, sampleRows } = result;
      const fieldNames = extraction.fields.map((f) => f.name).join(", ");
      const sampleSummary =
        sampleRows.length > 0
          ? `\nSample rows (first ${sampleRows.length}):\n${JSON.stringify(sampleRows, null, 2)}`
          : "\nNo sample rows extracted (rowCount may be 0).";

      return {
        success: true,
        observation:
          `ok=true\n` +
          `profile: ${profile}\n` +
          `isTable: ${isTable}\n` +
          `rowCount: ${rowCount}\n` +
          `fields: [${fieldNames}]\n` +
          `extraction: ${JSON.stringify(extraction, null, 2)}` +
          sampleSummary,
      };
    },
  };

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
        actionPrelude: {
          type: "array",
          description:
            "V1b: ordered deterministic pre-extraction action sequence. " +
            "Each step is executed in the tab before extraction begins. " +
            "Supports: navigate (url field), click, type (value field), " +
            "select (value field), submit. Locator signals resolve the target element. " +
            "Values may contain {{paramName}} placeholders (see parameters).",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "click | type | select | navigate | submit" },
              locator: { type: "object", description: "MultiSignalLocator for click/type/select/submit." },
              value: { type: "string", description: "Value for type/select steps; may use {{param}}." },
              url: { type: "string", description: "Navigate target URL; may use {{param}}." },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        parameters: {
          type: "array",
          description:
            "V1c: named parameter definitions for {{placeholder}} substitution in actionPrelude. " +
            "Each parameter has a name, type (always 'string'), and optional default value. " +
            "The user fills these in the parameter form before running.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Parameter name (matches {{name}} in steps)." },
              type: { type: "string", description: "Always 'string'." },
              default: { type: "string", description: "Optional default value shown in the form." },
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

      // V1b: accept optional actionPrelude (array of ActionStep).
      // Guard: only store if it's a non-empty array of objects.
      const actionPrelude: ActionStep[] | undefined =
        Array.isArray(a.actionPrelude) && a.actionPrelude.length > 0
          ? (a.actionPrelude as ActionStep[])
          : undefined;

      // V1c: accept optional parameters (array of RecipeParam).
      const parameters: RecipeParam[] | undefined =
        Array.isArray(a.parameters) && a.parameters.length > 0
          ? (a.parameters as RecipeParam[])
          : undefined;

      const recipe: Recipe = {
        id: generateRecipeId(),
        name: a.name.trim(),
        createdAt: Date.now(),
        author: "llm",
        targetUrlPattern: a.targetUrlPattern.trim(),
        extraction,
        outputSchema,
        ...(actionPrelude ? { actionPrelude } : {}),
        ...(parameters ? { parameters } : {}),
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

  return [detectRecipeStructureTool, saveRecipeTool, runRecipeTool];
}
// Note: canonical tool name lists live in tool-names.ts — do not re-export them here.
