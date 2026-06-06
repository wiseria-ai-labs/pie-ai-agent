// src/lib/recipes/run-recipe.ts
import type { ExtractionSpec, RecordRow, RunResult } from "./types";
import type { Recipe } from "./recipe-types";
import { accumulate } from "./engine";
import { shouldContinue, nextUrl } from "./paginate";

export interface ExtractPageResult {
  records: RecordRow[];
  hasNext: boolean;
}

/**
 * Injectable deps for testability — callers inject real chrome APIs in prod,
 * mocks in tests.
 */
export interface RunDeps {
  /** Injects extraction logic into the given tab and returns results. */
  extractOnTab: (tabId: number, ex: ExtractionSpec) => Promise<ExtractPageResult>;
  /** Navigates the tab to the given URL and waits for completion. */
  navigate: (tabId: number, url: string) => Promise<void>;
  /** Clicks the next-button in-page; returns true if the button was found+clicked. */
  clickNext: (tabId: number, ex: ExtractionSpec) => Promise<boolean>;
  /** Waits for the configured inter-page delay. */
  pace: () => Promise<void>;
  /** Returns the current timestamp (ms). Default: Date.now. */
  now: () => number;
}

export async function runRecipe(
  recipe: Recipe,
  tabId: number,
  params: Record<string, string>,
  deps: RunDeps,
): Promise<RunResult> {
  const { extraction } = recipe;
  const { pagination, stopCondition } = extraction;

  const runAt = deps.now();
  const sourceUrl = pagination.urlTemplate
    ? nextUrl(pagination.urlTemplate, 1)
    : "";

  const perPageRows: RecordRow[][] = [];
  let pageCount = 0;
  let hasNext = true;

  // Navigate to first URL for url-param mode
  if (pagination.mode === "url-param" && pagination.urlTemplate) {
    const firstUrl = nextUrl(pagination.urlTemplate, 1);
    await deps.navigate(tabId, firstUrl);
  }

  while (true) {
    // Extract current page
    const { records: pageRecords, hasNext: pageHasNext } = await deps.extractOnTab(tabId, extraction);
    perPageRows.push(pageRecords);
    pageCount++;
    hasNext = pageHasNext;

    // Check stop condition using V1a-1 accumulate + shouldContinue
    const { newCountPerPage } = accumulate(perPageRows);
    const lastPageNewRows = newCountPerPage[newCountPerPage.length - 1] ?? 0;

    const continueState = {
      pageCount,
      lastPageNewRows,
      hasNext,
    };

    if (!shouldContinue(continueState, stopCondition)) break;

    // Pace before navigating to next page
    await deps.pace();

    // Navigate to next page
    if (pagination.mode === "url-param" && pagination.urlTemplate) {
      const url = nextUrl(pagination.urlTemplate, pageCount + 1);
      await deps.navigate(tabId, url);
    } else if (pagination.mode === "next-button" || pagination.mode === "load-more") {
      const clicked = await deps.clickNext(tabId, extraction);
      if (!clicked) break; // no next button found, stop
    } else {
      // infinite-scroll or unsupported: stop after first page
      break;
    }
  }

  // Merge all pages, deduplicate
  const { rows } = accumulate(perPageRows);

  return {
    recipeId: recipe.id,
    runAt,
    params,
    sourceUrl,
    pageCount,
    schema: recipe.outputSchema,
    records: rows,
  };
}
