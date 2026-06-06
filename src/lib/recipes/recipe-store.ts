// src/lib/recipes/recipe-store.ts
import type { Recipe } from "./recipe-types";

const DB_NAME = "pie-recipes";
const STORE = "recipes";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function putRecipe(recipe: Recipe): Promise<void> {
  await tx("readwrite", (s) => s.put(recipe));
}

export async function getRecipe(id: string): Promise<Recipe | null> {
  const r = await tx<Recipe | undefined>("readonly", (s) => s.get(id));
  return r ?? null;
}

export async function listRecipes(): Promise<Recipe[]> {
  return tx<Recipe[]>("readonly", (s) => s.getAll());
}

export async function deleteRecipe(id: string): Promise<void> {
  await tx<undefined>("readwrite", (s) => s.delete(id));
}
