// src/lib/inbox/store.ts
//
// CRUD for the `inbox` IDB store (Pie 2.0 §6). Every write publishes a
// store-bus change so the panel's activity feed + the top-bar unread dot stay
// live without polling.

import { tx, txMulti, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";
import {
  MAX_INBOX_ENTRIES,
  MAX_INBOX_ENTRIES_PER_REF,
  newInboxId,
  type InboxEntry,
  type InboxKind,
  type InboxSource,
} from "./types";

/** All inbox entries, newest first. */
export async function listInbox(): Promise<InboxEntry[]> {
  const all = await tx<InboxEntry[]>(STORES.inbox, "readonly", (s) =>
    s.getAll() as IDBRequest<InboxEntry[]>,
  );
  return all.sort((a, b) => b.at - a.at);
}

export async function unreadInboxCount(): Promise<number> {
  const all = await listInbox();
  return all.reduce((n, e) => (e.read ? n : n + 1), 0);
}

export interface AddInboxInput {
  source: InboxSource;
  refId: string;
  kind: InboxKind;
  title: string;
  body?: string;
  data?: Record<string, string>;
  at?: number;
  /** 幂等迁移用；缺省生成新 id。 */
  id?: string;
  read?: boolean;
}

/**
 * Append one entry, then trim: keep at most MAX_INBOX_ENTRIES overall and
 * MAX_INBOX_ENTRIES_PER_REF per refId (oldest dropped first). Put + trims run
 * in one transaction so a burst can't leave the store over the cap.
 */
export async function addInboxEntry(input: AddInboxInput): Promise<InboxEntry> {
  const entry: InboxEntry = {
    id: input.id ?? newInboxId(),
    source: input.source,
    refId: input.refId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? "",
    ...(input.data ? { data: input.data } : {}),
    at: input.at ?? Date.now(),
    read: input.read ?? false,
  };

  const removed: string[] = [];
  await txMulti([STORES.inbox], "readwrite", (m) => {
    const store = m[STORES.inbox];
    store.put(entry);
    const getReq = store.getAll() as IDBRequest<InboxEntry[]>;
    getReq.onsuccess = () => {
      const all = getReq.result.sort((a, b) => a.at - b.at); // oldest first
      const perRefKeep = new Map<string, InboxEntry[]>();
      for (const e of all) {
        const arr = perRefKeep.get(e.refId) ?? [];
        arr.push(e);
        perRefKeep.set(e.refId, arr);
      }
      const drop = new Set<string>();
      for (const [, arr] of perRefKeep) {
        for (const e of arr.slice(0, Math.max(0, arr.length - MAX_INBOX_ENTRIES_PER_REF))) {
          drop.add(e.id);
        }
      }
      // Global cap: drop the oldest non-already-dropped entries.
      const survivors = all.filter((e) => !drop.has(e.id));
      for (const e of survivors.slice(0, Math.max(0, survivors.length - MAX_INBOX_ENTRIES))) {
        drop.add(e.id);
      }
      for (const id of drop) {
        // `continue`, not `return`: the just-written row may itself be the
        // oldest (migration replays an old `at`), and bailing here would leave
        // every other doomed row in the store, over both caps.
        if (id === entry.id) continue;
        store.delete(id);
        removed.push(id);
      }
    };
  });

  publishChange(STORES.inbox, "put", entry.id);
  for (const id of removed) publishChange(STORES.inbox, "remove", id);
  return entry;
}

/** Mark one entry read (no-op for unknown ids). */
export async function markInboxRead(id: string): Promise<void> {
  await txMulti([STORES.inbox], "readwrite", (m) => {
    const store = m[STORES.inbox];
    const getReq = store.get(id) as IDBRequest<InboxEntry | undefined>;
    getReq.onerror = () => store.transaction.abort();
    getReq.onsuccess = () => {
      const e = getReq.result;
      if (!e || e.read) return;
      store.put({ ...e, read: true });
    };
  });
  publishChange(STORES.inbox, "put", id);
}

/** Mark every unread entry read (called when the activity feed is opened). */
export async function markAllInboxRead(): Promise<void> {
  const all = await listInbox();
  const unread = all.filter((e) => !e.read);
  if (unread.length === 0) return;
  await txMulti([STORES.inbox], "readwrite", (m) => {
    for (const e of unread) m[STORES.inbox].put({ ...e, read: true });
  });
  for (const e of unread) publishChange(STORES.inbox, "put", e.id);
}

/** Drop every entry belonging to a deleted monitor/schedule. */
export async function deleteInboxByRef(refId: string): Promise<void> {
  const all = await listInbox();
  const doomed = all.filter((e) => e.refId === refId);
  if (doomed.length === 0) return;
  await txMulti([STORES.inbox], "readwrite", (m) => {
    for (const e of doomed) m[STORES.inbox].delete(e.id);
  });
  for (const e of doomed) publishChange(STORES.inbox, "remove", e.id);
}

/** Test helper — direct read of a single entry. */
export async function getInboxEntry(id: string): Promise<InboxEntry | null> {
  const e = await tx<InboxEntry | undefined>(STORES.inbox, "readonly", (s) =>
    s.get(id) as IDBRequest<InboxEntry | undefined>,
  );
  return e ?? null;
}
