// Change log for Pie's bookmark / history mutations (IDB `bookmark_snapshots`).
//
// One row per applied change (F17 "Pie 做过的改动"). Bookmark rows carry the
// inverse ops captured BEFORE applying, so restore can withdraw exactly that
// change and leave later user edits untouched. History deletions carry no
// snapshot — they are logged with `restorable:false` and shown as 不可还原.
//
// Retention: 30 days, pruned lazily whenever the list is read or written.

import { tx, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";
import type { BrowserChangeRecord } from "./types";

export const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function putChange(
  rec: Omit<BrowserChangeRecord, "id" | "at"> & { id?: string; at?: number },
): Promise<BrowserChangeRecord> {
  const full: BrowserChangeRecord = {
    ...rec,
    id: rec.id ?? `bd_${crypto.randomUUID()}`,
    at: rec.at ?? Date.now(),
  };
  await tx(STORES.bookmarkSnapshots, "readwrite", (s) => s.put(full));
  publishChange(STORES.bookmarkSnapshots, "put", full.id);
  return full;
}

export async function getChange(id: string): Promise<BrowserChangeRecord | null> {
  const row = await tx<BrowserChangeRecord | undefined>(
    STORES.bookmarkSnapshots,
    "readonly",
    (s) => s.get(id) as IDBRequest<BrowserChangeRecord | undefined>,
  );
  return row ?? null;
}

/** Newest first, expired rows pruned on the way out. */
export async function listChanges(now = Date.now()): Promise<BrowserChangeRecord[]> {
  const all = await tx<BrowserChangeRecord[]>(
    STORES.bookmarkSnapshots,
    "readonly",
    (s) => s.getAll() as IDBRequest<BrowserChangeRecord[]>,
  );
  const expired = all.filter((r) => now - r.at > CHANGE_RETENTION_MS);
  if (expired.length > 0) {
    await tx(STORES.bookmarkSnapshots, "readwrite", (s) => {
      for (const r of expired) s.delete(r.id);
      return s.count();
    });
    publishChange(STORES.bookmarkSnapshots, "remove");
  }
  return all
    .filter((r) => now - r.at <= CHANGE_RETENTION_MS)
    .sort((a, b) => b.at - a.at);
}

export async function markChangeRestored(id: string): Promise<void> {
  const row = await getChange(id);
  if (!row) return;
  const next = { ...row, restoredAt: Date.now() };
  await tx(STORES.bookmarkSnapshots, "readwrite", (s) => s.put(next));
  publishChange(STORES.bookmarkSnapshots, "put", id);
}
