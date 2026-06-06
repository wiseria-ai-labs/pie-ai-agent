// src/sidepanel/components/RecipesList.test.tsx
//
// Tests for RecipesList — renders recipe list, handles run / delete flows,
// param form visibility, and SW message dispatch.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { chromeMock } from "@/test/setup";

// ── Mock recipe-store ─────────────────────────────────────────────────────────

const mockListRecipes = vi.fn();
const mockDeleteRecipe = vi.fn();

vi.mock("@/lib/recipes/recipe-store", () => ({
  listRecipes: (...args: unknown[]) => mockListRecipes(...args),
  deleteRecipe: (...args: unknown[]) => mockDeleteRecipe(...args),
}));

// ── Import component after mocks ──────────────────────────────────────────────

import RecipesList from "./RecipesList";
import type { Recipe } from "@/lib/recipes/recipe-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecipe(overrides: Partial<Recipe> & { id: string }): Recipe {
  return {
    id: overrides.id,
    name: overrides.name ?? `Recipe ${overrides.id}`,
    createdAt: overrides.createdAt ?? Date.now(),
    author: overrides.author ?? "llm",
    targetUrlPattern: overrides.targetUrlPattern ?? "https://example.com/*",
    extraction: {
      container: { signals: [] },
      rowLocator: { signals: [] },
      fields: [],
      pagination: { mode: "next-button" },
      stopCondition: {},
    },
    outputSchema: overrides.outputSchema ?? [],
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mockListRecipes.mockReset();
  mockListRecipes.mockResolvedValue([]);
  mockDeleteRecipe.mockReset();
  mockDeleteRecipe.mockResolvedValue(undefined);
  chromeMock.runtime.sendMessage.mockReset();
});

afterEach(() => {
  cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RecipesList — empty state", () => {
  it("shows empty state message when no recipes", async () => {
    mockListRecipes.mockResolvedValue([]);
    render(<RecipesList />);
    await waitFor(() => {
      expect(screen.getByText(/no recipes yet/i)).toBeTruthy();
    });
  });
});

describe("RecipesList — list rendering", () => {
  it("renders recipe names for multiple recipes", async () => {
    const recipes = [
      makeRecipe({ id: "r1", name: "Product Scraper" }),
      makeRecipe({ id: "r2", name: "Review Collector" }),
    ];
    mockListRecipes.mockResolvedValue(recipes);
    render(<RecipesList />);
    await waitFor(() => {
      expect(screen.getByText("Product Scraper")).toBeTruthy();
      expect(screen.getByText("Review Collector")).toBeTruthy();
    });
  });

  it("shows targetUrlPattern for each recipe", async () => {
    const recipes = [
      makeRecipe({ id: "r1", name: "My Recipe", targetUrlPattern: "https://shop.com/*" }),
    ];
    mockListRecipes.mockResolvedValue(recipes);
    render(<RecipesList />);
    await waitFor(() => {
      expect(screen.getByText("https://shop.com/*")).toBeTruthy();
    });
  });

  it("shows Run button for each recipe", async () => {
    const recipes = [
      makeRecipe({ id: "r1", name: "Alpha" }),
      makeRecipe({ id: "r2", name: "Beta" }),
    ];
    mockListRecipes.mockResolvedValue(recipes);
    render(<RecipesList />);
    await waitFor(() => {
      const runButtons = screen.getAllByRole("button", { name: /run/i });
      // At least 2 run buttons (one per recipe)
      expect(runButtons.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("RecipesList — run dispatch", () => {
  it("calls chrome.runtime.sendMessage with run-recipe on Run click", async () => {
    const recipe = makeRecipe({ id: "r1", name: "Scraper" });
    mockListRecipes.mockResolvedValue([recipe]);
    chromeMock.runtime.sendMessage.mockResolvedValue({ ok: true, rows: [], files: [] });

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Scraper"));

    fireEvent.click(screen.getByRole("button", { name: /run recipe/i }));

    await waitFor(() => {
      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
        type: "run-recipe",
        recipeId: "r1",
        params: {},
      });
    });
  });

  it("shows extracted rows count after successful run", async () => {
    const recipe = makeRecipe({ id: "r1", name: "Scraper" });
    mockListRecipes.mockResolvedValue([recipe]);
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      rows: [{ title: "A" }, { title: "B" }, { title: "C" }],
      files: ["recipe_Scraper_2026-01-01.csv"],
    });

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Scraper"));

    fireEvent.click(screen.getByRole("button", { name: /run recipe/i }));

    await waitFor(() => {
      expect(screen.getByText(/3 rows extracted/i)).toBeTruthy();
    });
  });

  it("shows downloaded filenames after successful run", async () => {
    const recipe = makeRecipe({ id: "r1", name: "Scraper" });
    mockListRecipes.mockResolvedValue([recipe]);
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      rows: [{ x: "y" }],
      files: ["recipe_Scraper_2026.csv", "recipe_Scraper_2026.json"],
    });

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Scraper"));
    fireEvent.click(screen.getByRole("button", { name: /run recipe/i }));

    await waitFor(() => {
      expect(screen.getByText(/pie\/recipe_Scraper_2026\.csv/i)).toBeTruthy();
    });
  });

  it("shows error message on run failure", async () => {
    const recipe = makeRecipe({ id: "r1", name: "Scraper" });
    mockListRecipes.mockResolvedValue([recipe]);
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: false,
      error: "Tab not found",
    });

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Scraper"));
    fireEvent.click(screen.getByRole("button", { name: /run recipe/i }));

    await waitFor(() => {
      expect(screen.getByText(/tab not found/i)).toBeTruthy();
    });
  });
});

describe("RecipesList — parameter form", () => {
  it("shows parameter form before running when recipe has parameters", async () => {
    const recipe = {
      ...makeRecipe({ id: "r1", name: "Parameterised" }),
      parameters: [{ name: "maxPages", description: "Max pages to scrape" }],
    } as Recipe & { parameters: { name: string; description?: string }[] };
    mockListRecipes.mockResolvedValue([recipe as Recipe]);

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Parameterised"));

    fireEvent.click(screen.getByRole("button", { name: /run recipe/i }));

    // Param form should appear; sendMessage NOT yet called
    expect(screen.getByLabelText("maxPages")).toBeTruthy();
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe("RecipesList — delete flow", () => {
  it("calls deleteRecipe when user confirms delete", async () => {
    const recipe = makeRecipe({ id: "r1", name: "Old Recipe" });
    mockListRecipes.mockResolvedValue([recipe]);
    mockDeleteRecipe.mockResolvedValue(undefined);

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Old Recipe"));

    // First click: ask to delete
    fireEvent.click(screen.getByRole("button", { name: /delete recipe/i }));

    // Confirm button should appear
    const confirmBtn = screen.getByRole("button", { name: /confirm delete/i });
    expect(confirmBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mockDeleteRecipe).toHaveBeenCalledWith("r1");
  });

  it("cancels delete without calling deleteRecipe", async () => {
    const recipe = makeRecipe({ id: "r1", name: "Old Recipe" });
    mockListRecipes.mockResolvedValue([recipe]);

    render(<RecipesList />);
    await waitFor(() => screen.getByText("Old Recipe"));

    fireEvent.click(screen.getByRole("button", { name: /delete recipe/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel delete/i }));

    expect(mockDeleteRecipe).not.toHaveBeenCalled();
  });
});
