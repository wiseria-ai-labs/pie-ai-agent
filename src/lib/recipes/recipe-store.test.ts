import { describe, it, expect, beforeEach } from "vitest";
import { putRecipe, getRecipe, listRecipes, deleteRecipe } from "./recipe-store";
import type { Recipe } from "./recipe-types";

const makeRecipe = (id: string): Recipe => ({
  id,
  name: `Recipe ${id}`,
  createdAt: 1_000_000,
  author: "llm",
  targetUrlPattern: `https://example.com/${id}`,
  extraction: {
    container: { signals: [{ kind: "class", value: "div.container", stable: true }] },
    rowLocator: { signals: [{ kind: "class", value: "li.item", stable: true }] },
    fields: [{ name: "title", locator: { signals: [{ kind: "class", value: "span.title", stable: true }] } }],
    pagination: { mode: "url-param", urlTemplate: "https://example.com/{n}" },
    stopCondition: { maxPages: 5 },
  },
  outputSchema: [{ name: "title", type: "string" }],
});

describe("recipe-store (IndexedDB)", () => {
  beforeEach(async () => {
    for (const r of await listRecipes()) await deleteRecipe(r.id);
  });

  it("put + get round-trips", async () => {
    const r = makeRecipe("r1");
    await putRecipe(r);
    const got = await getRecipe("r1");
    expect(got?.name).toBe("Recipe r1");
    expect(got?.author).toBe("llm");
    expect(got?.targetUrlPattern).toBe("https://example.com/r1");
  });

  it("getRecipe returns null for unknown id", async () => {
    expect(await getRecipe("does-not-exist")).toBeNull();
  });

  it("list returns all recipes", async () => {
    await putRecipe(makeRecipe("a"));
    await putRecipe(makeRecipe("b"));
    const ids = (await listRecipes()).map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("delete removes recipe", async () => {
    await putRecipe(makeRecipe("del"));
    await deleteRecipe("del");
    expect(await getRecipe("del")).toBeNull();
  });

  it("put overwrites existing recipe", async () => {
    const r = makeRecipe("upd");
    await putRecipe(r);
    await putRecipe({ ...r, name: "Updated Name" });
    const got = await getRecipe("upd");
    expect(got?.name).toBe("Updated Name");
  });
});
