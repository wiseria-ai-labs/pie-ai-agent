// src/sidepanel/components/RecipesList.tsx
//
// Recipes tab in Settings — lists saved recipes, lets the user run or delete them.
// Run path: panel → chrome.runtime.sendMessage({type:"run-recipe",...}) → SW →
//   executeRecipe → responds with {ok, rows, files} or {ok:false, error}.
//
// Parameters form: reserved for V1c. V1 recipes carry no parameters; the form
// section is shown only when recipe.parameters?.length is truthy so V1 skips
// straight to the run dispatch.

import { useState, useEffect } from "react";
import { listRecipes, deleteRecipe } from "@/lib/recipes/recipe-store";
import type { Recipe, RecipeParam } from "@/lib/recipes/recipe-types";

// ── Types for SW response ─────────────────────────────────────────────────────

interface RunRecipeOkResponse {
  ok: true;
  rows: Record<string, string>[];
  files: string[];
}
interface RunRecipeErrResponse {
  ok: false;
  error: string;
}
type RunRecipeResponse = RunRecipeOkResponse | RunRecipeErrResponse;

// ── RunResult display ─────────────────────────────────────────────────────────

interface RunResultState {
  recipeId: string;
  rows: number;
  files: string[];
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecipesList() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunResultState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // V1c: parameter form state. recipeId → {paramName → value}
  const [paramForms, setParamForms] = useState<Record<string, Record<string, string>>>({});
  const [showParamFor, setShowParamFor] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const all = await listRecipes();
      // Newest first
      const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
      setRecipes(sorted);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteRecipe(id);
      setConfirmDeleteId(null);
      setShowParamFor(null);
      await load();
    } catch (e) {
      console.error("[RecipesList] deleteRecipe failed:", e);
    }
  }

  function handleRunClick(recipe: Recipe) {
    const recipeParams = recipe.parameters as RecipeParam[] | undefined;
    const hasParams = Array.isArray(recipeParams) && recipeParams.length > 0;

    if (hasParams && showParamFor !== recipe.id) {
      // Pre-populate defaults if not already set
      setParamForms((prev) => {
        if (prev[recipe.id]) return prev; // already populated
        const defaults: Record<string, string> = {};
        for (const p of recipeParams!) {
          if (p.default !== undefined) {
            defaults[p.name] = p.default;
          }
        }
        return { ...prev, [recipe.id]: defaults };
      });
      // Show param form first
      setShowParamFor(recipe.id);
      return;
    }

    const params = paramForms[recipe.id] ?? {};
    void dispatchRun(recipe.id, params);
    setShowParamFor(null);
  }

  async function dispatchRun(recipeId: string, params: Record<string, string>) {
    setRunningId(recipeId);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[recipeId];
      return next;
    });
    setResults((prev) => {
      const next = { ...prev };
      delete next[recipeId];
      return next;
    });

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "run-recipe",
        recipeId,
        params,
      }) as RunRecipeResponse | undefined;

      if (!resp) {
        setErrors((prev) => ({ ...prev, [recipeId]: "No response from background" }));
        return;
      }

      if (!resp.ok) {
        setErrors((prev) => ({ ...prev, [recipeId]: resp.error }));
        return;
      }

      setResults((prev) => ({
        ...prev,
        [recipeId]: { recipeId, rows: resp.rows.length, files: resp.files },
      }));
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [recipeId]: e instanceof Error ? e.message : "Run failed",
      }));
    } finally {
      setRunningId(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col gap-7">
        <p className="text-[12px] text-fg-3">Loading recipes…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <span className="caps text-fg-3">Recipes</span>
          <span className="font-mono text-[10px] text-fg-3">
            {recipes.length} recipe{recipes.length === 1 ? "" : "s"}
          </span>
        </div>
        <div
          style={{
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--c-fg-2, #888)",
            background: "var(--c-bg-2, transparent)",
            borderLeft: "2px solid var(--c-line, #ccc)",
            lineHeight: 1.5,
          }}
        >
          Saved extraction recipes. Run one to scrape the active tab and download CSV + JSON.
        </div>
      </section>

      {recipes.length === 0 ? (
        <p className="text-[12px] text-fg-3">No recipes yet. Ask the agent to record one.</p>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
            {recipes.map((recipe) => (
              <RecipeRow
                key={recipe.id}
                recipe={recipe}
                running={runningId === recipe.id}
                result={results[recipe.id]}
                error={errors[recipe.id]}
                showParamForm={showParamFor === recipe.id}
                paramValues={paramForms[recipe.id] ?? {}}
                confirmDelete={confirmDeleteId === recipe.id}
                onRun={() => handleRunClick(recipe)}
                onParamChange={(name, value) => {
                  setParamForms((prev) => ({
                    ...prev,
                    [recipe.id]: { ...(prev[recipe.id] ?? {}), [name]: value },
                  }));
                }}
                onCancelParams={() => setShowParamFor(null)}
                onAskDelete={() => setConfirmDeleteId(recipe.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onDelete={() => handleDelete(recipe.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── RecipeRow ─────────────────────────────────────────────────────────────────

function RecipeRow({
  recipe,
  running,
  result,
  error,
  showParamForm,
  paramValues,
  confirmDelete,
  onRun,
  onParamChange,
  onCancelParams,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  recipe: Recipe;
  running: boolean;
  result?: RunResultState;
  error?: string;
  showParamForm: boolean;
  paramValues: Record<string, string>;
  confirmDelete: boolean;
  onRun: () => void;
  onParamChange: (name: string, value: string) => void;
  onCancelParams: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const recipeParams = recipe.parameters as RecipeParam[] | undefined;
  const hasParams = Array.isArray(recipeParams) && recipeParams.length > 0;
  const params = recipeParams ?? [];

  return (
    <div className="flex flex-col gap-2 bg-surface px-3.5 py-3.5">
      {/* Header row */}
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[12px] text-accent">{recipe.name}</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
          {recipe.author}
        </span>
      </div>

      {/* URL pattern */}
      <p className="text-[12px] leading-[18px] text-fg-2">
        <span className="font-mono text-[10px] text-fg-3">url: </span>
        {recipe.targetUrlPattern}
      </p>

      {/* Parameter form (V1c: shown when recipe has params) */}
      {showParamForm && hasParams && (
        <div className="flex flex-col gap-2 rounded border border-line bg-field p-2.5">
          {params.map((p) => (
            <label key={p.name} className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-fg-3">{p.name}</span>
              <input
                aria-label={p.name}
                value={paramValues[p.name] ?? p.default ?? ""}
                onChange={(e) => onParamChange(p.name, e.target.value)}
                placeholder={p.default ?? p.name}
                className="w-full rounded border border-line bg-canvas px-2 py-1 text-[12px] text-fg-1 placeholder:text-fg-3"
              />
            </label>
          ))}
        </div>
      )}

      {/* Result / error */}
      {result && (
        <div className="rounded border border-line bg-field px-2.5 py-1.5 text-[12px] text-fg-2">
          <span>{result.rows} row{result.rows === 1 ? "" : "s"} extracted</span>
          {result.files.length > 0 && (
            <ul className="mt-0.5 flex flex-col gap-0.5 font-mono text-[10px] text-accent">
              {result.files.map((f) => (
                <li key={f}>Downloaded: pie/{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <div className="rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[12px] text-warning">
          {error}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1.5">
        <button
          onClick={onRun}
          disabled={running}
          className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={running ? "Running…" : hasParams && showParamForm ? "Confirm Run" : "Run recipe"}
        >
          {running ? "Running…" : hasParams && showParamForm ? "Confirm Run" : "Run"}
        </button>

        {showParamForm && !running && (
          <button
            onClick={onCancelParams}
            className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:text-fg-1"
            aria-label="Cancel params"
          >
            Cancel
          </button>
        )}

        {confirmDelete ? (
          <>
            <button
              onClick={onDelete}
              className="rounded border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
              aria-label="Confirm delete"
            >
              Confirm
            </button>
            <button
              onClick={onCancelDelete}
              className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
              aria-label="Cancel delete"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={onAskDelete}
            className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
            aria-label="Delete recipe"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
