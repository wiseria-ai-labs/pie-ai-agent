// src/lib/recipes/execute-recipe.ts
//
// Shared orchestration layer: getRecipe → assemble RunDeps → runRecipe →
// serialise to CSV + JSON → optionally download both files.
//
// ⚠️  Real chrome deps (navigate via chrome.tabs.update, click via
//      chrome.scripting.executeScript, scroll via executeScript) require a
//      privileged extension context and MUST be verified with a real device.
//      The `buildRealDeps` function is annotated accordingly.
//
// For unit tests, inject mock deps via the optional `deps` / `store` parameters.

import type { Recipe } from "./recipe-types";
import type { RunDeps, ExtractPageResult } from "./run-recipe";
import type { ExtractionSpec, RecordRow, RunResult } from "./types";
import { runRecipe } from "./run-recipe";
import { toCSV, toJSON } from "./output";
import { jitterDelay, pace } from "./pacing";

// ── Optional injection interfaces ─────────────────────────────────────────────

export interface RecipeStore {
  getRecipe: (id: string) => Promise<Recipe | null>;
}

export interface Downloader {
  download: (filename: string, content: string, mime: string) => Promise<void>;
}

export interface ExecuteRecipeDeps {
  runDeps: RunDeps;
  store: RecipeStore;
  downloader?: Downloader;
}

export interface ExecuteRecipeResult {
  rows: RecordRow[];
  runResult: RunResult;
  /** Filenames that were downloaded, if a downloader was provided. */
  files: string[];
}

// ── Real chrome dep construction ──────────────────────────────────────────────
//
// ⚠️  NEEDS REAL-DEVICE VERIFICATION — executeScript injection, tab navigation,
//      and chrome.downloads all require a privileged extension context.

/**
 * Build a navigate dep: updates the tab URL and waits for the load to complete.
 * Uses chrome.tabs.update + a chrome.tabs.onUpdated listener.
 *
 * // 需真机验证: tab navigation + event-listener teardown under real extension runtime.
 */
function buildNavigate(): RunDeps["navigate"] {
  return (tabId: number, url: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Listen for the tab completing its load before resolving.
      function onUpdated(id: number, info: chrome.tabs.OnUpdatedInfo) {
        if (id !== tabId) return;
        if (info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.update(tabId, { url }).catch((err) => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(err);
      });
    });
  };
}

/**
 * Build a clickNext dep: injects a self-contained function that resolves
 * the next-button locator and clicks it.
 *
 * // 需真机验证: executeScript injection + locator resolution inside page context.
 */
function buildClickNext(): RunDeps["clickNext"] {
  return async (tabId: number, ex: ExtractionSpec): Promise<boolean> => {
    const { next } = ex.pagination;
    if (!next) return false;

    // Self-contained injected function — no imports, no outer-scope closures.
    function clickNextInPage(serializedLocator: string): boolean {
      type SignalKind = "testid" | "id" | "name" | "aria-label" | "role+name" | "text" | "class" | "column" | "nth";
      interface LocatorSignal { kind: SignalKind; value: string; stable: boolean }
      interface MultiSignalLocator { signals: LocatorSignal[] }

      function normText(s: string | null | undefined): string {
        return (s ?? "").replace(/\s+/g, " ").trim();
      }
      function matchByText(root: ParentNode, text: string): Element[] {
        const want = normText(text).toLowerCase();
        if (!want) return [];
        return [...root.querySelectorAll("a,button,[role='button'],[role='link']")].filter(
          (el) => normText(el.textContent).toLowerCase().includes(want),
        );
      }
      function matchByRoleName(root: ParentNode, value: string): Element | null {
        const [role, name] = value.split("|");
        const want = normText(name).toLowerCase();
        const cands = [...root.querySelectorAll(`[role="${role}"], ${role}`)];
        return (
          cands.find((el) => {
            const label = normText(el.getAttribute("aria-label") || el.textContent).toLowerCase();
            return want ? label.includes(want) : true;
          }) ?? null
        );
      }
      function resolveOne(root: ParentNode, loc: MultiSignalLocator): Element | null {
        for (const sig of loc.signals) {
          switch (sig.kind) {
            case "id": { const el = root.querySelector(`[id="${sig.value}"]`); if (el) return el; break; }
            case "testid": { const sel = sig.value.startsWith("[") ? sig.value : `[data-testid="${sig.value}"]`; const el = root.querySelector(sel); if (el) return el; break; }
            case "name": { const el = root.querySelector(`[name="${sig.value}"]`); if (el) return el; break; }
            case "aria-label": { const el = root.querySelector(`[aria-label="${sig.value}"]`); if (el) return el; break; }
            case "class": { const el = root.querySelector(sig.value); if (el) return el; break; }
            case "nth": { const el = root.querySelector(sig.value); if (el) return el; break; }
            case "text": { const el = matchByText(root, sig.value)[0]; if (el) return el; break; }
            case "role+name": { const el = matchByRoleName(root, sig.value); if (el) return el; break; }
          }
        }
        return null;
      }

      const loc = JSON.parse(serializedLocator) as MultiSignalLocator;
      const btn = resolveOne(document, loc);
      if (!btn) return false;
      (btn as HTMLElement).click();
      return true;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: clickNextInPage,
        args: [JSON.stringify(next)],
      });
      return (results[0]?.result as boolean) ?? false;
    } catch {
      return false;
    }
  };
}

/**
 * Build a scrollContainer dep: injects a function that scrolls the page
 * container downward by one viewport height.
 *
 * // 需真机验证: executeScript scroll injection + infinite-scroll detection.
 */
function buildScrollContainer(): NonNullable<RunDeps["scrollContainer"]> {
  return async (tabId: number): Promise<boolean> => {
    function scrollInPage(): boolean {
      const before = window.scrollY;
      window.scrollBy({ top: window.innerHeight, behavior: "instant" });
      return window.scrollY !== before;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollInPage,
        args: [],
      });
      return (results[0]?.result as boolean) ?? false;
    } catch {
      return false;
    }
  };
}

/**
 * Build a pace dep with jitter delay.
 */
function buildPace(): RunDeps["pace"] {
  return async (): Promise<void> => {
    const ms = jitterDelay();
    await pace(ms);
  };
}

/**
 * Construct real chrome RunDeps for production use.
 * The extractOnTab function is passed in to avoid circular import issues.
 *
 * // 需真机验证: all deps rely on privileged extension APIs and real page contexts.
 */
export function buildRealRunDeps(
  extractOnTabFn: (tabId: number, ex: ExtractionSpec) => Promise<ExtractPageResult>,
): RunDeps {
  return {
    extractOnTab: extractOnTabFn,
    navigate: buildNavigate(),
    clickNext: buildClickNext(),
    scrollContainer: buildScrollContainer(),
    pace: buildPace(),
    now: () => Date.now(),
  };
}

/**
 * Build a chrome.downloads-backed downloader.
 *
 * // 需真机验证: chrome.downloads.download requires Downloads permission and a real device.
 */
export function buildChromeDownloader(): Downloader {
  return {
    download: async (filename: string, content: string, mime: string): Promise<void> => {
      const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
      await chrome.downloads.download({
        url,
        filename: `pie/${filename}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
    },
  };
}

// ── Core executeRecipe ────────────────────────────────────────────────────────

/**
 * Orchestrate a recipe run:
 *  1. Load recipe from store.
 *  2. Run extraction via runRecipe (injectable deps).
 *  3. Serialise to CSV + JSON.
 *  4. Optionally download both files via the injected downloader.
 *  5. Return { rows, runResult, files }.
 *
 * @param recipeId  The recipe to run.
 * @param tabId     The tab to extract from (current active tab in production).
 * @param params    Runtime params (e.g. URL overrides).
 * @param deps      Optional dep injection for testing. If omitted, caller must
 *                  supply deps explicitly.
 */
export async function executeRecipe(
  recipeId: string,
  tabId: number,
  params: Record<string, string>,
  deps: ExecuteRecipeDeps,
): Promise<ExecuteRecipeResult> {
  const { store, runDeps, downloader } = deps;

  // 1. Load recipe
  const recipe = await store.getRecipe(recipeId);
  if (!recipe) {
    throw new Error(`executeRecipe: recipe "${recipeId}" not found`);
  }

  // 2. Run
  const runResult = await runRecipe(recipe, tabId, params, runDeps);

  // 3. Serialise
  const csvContent = toCSV(runResult.records, runResult.schema);
  const jsonContent = toJSON(runResult);

  // 4. Download if a downloader is provided
  const files: string[] = [];
  if (downloader) {
    const safeName = recipe.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    const ts = new Date(runResult.runAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const csvFilename = `recipe_${safeName}_${ts}.csv`;
    const jsonFilename = `recipe_${safeName}_${ts}.json`;

    await downloader.download(csvFilename, csvContent, "text/csv");
    files.push(csvFilename);

    await downloader.download(jsonFilename, jsonContent, "application/json");
    files.push(jsonFilename);
  }

  return {
    rows: runResult.records,
    runResult,
    files,
  };
}
