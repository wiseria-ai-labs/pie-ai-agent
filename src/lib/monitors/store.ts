// src/lib/monitors/store.ts
//
// CRUD for the `monitors` IDB store (Pie 2.0 §4.1). Every write publishes a
// store-bus change so the monitor list / detail page stay live.
//
// patchMonitor is a single-transaction read-merge-write (never get+put pairs):
// a check result and a user pause can race, and the merge must see the latest
// record (same lost-update reasoning as schedules/store.ts patchSchedule).

import { tx, txMulti, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";
import {
  MONITOR_HISTORY_LIMIT,
  type MonitorHistoryEntry,
  type MonitorRecord,
} from "./types";

export async function getMonitor(id: string): Promise<MonitorRecord | null> {
  const r = await tx<MonitorRecord | undefined>(STORES.monitors, "readonly", (s) =>
    s.get(id) as IDBRequest<MonitorRecord | undefined>,
  );
  return r ?? null;
}

export async function listMonitors(): Promise<MonitorRecord[]> {
  const all = await tx<MonitorRecord[]>(STORES.monitors, "readonly", (s) =>
    s.getAll() as IDBRequest<MonitorRecord[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putMonitor(rec: MonitorRecord): Promise<void> {
  await tx<IDBValidKey>(STORES.monitors, "readwrite", (s) => s.put(rec));
  publishChange(STORES.monitors, "put", rec.id);
}

/** Atomic partial update. Silently no-ops for unknown ids. */
export async function patchMonitor(
  id: string,
  patch: Partial<Omit<MonitorRecord, "id">>,
): Promise<void> {
  await txMulti([STORES.monitors], "readwrite", (m) => {
    const store = m[STORES.monitors];
    const getReq = store.get(id) as IDBRequest<MonitorRecord | undefined>;
    // Abort on a failed inner get so the caller sees a rejection instead of a
    // silently-discarded patch.
    getReq.onerror = () => store.transaction.abort();
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return;
      store.put({ ...existing, ...patch, id });
    };
  });
  publishChange(STORES.monitors, "put", id);
}

/**
 * Append one history entry (circular, MONITOR_HISTORY_LIMIT) together with the
 * result fields it belongs with — one atomic write so a check can't half-land.
 * Pass `entry: null` when the value didn't materially change (a 15-minute poll
 * that returns the same number is not a "change record").
 */
export async function appendMonitorResult(
  id: string,
  entry: MonitorHistoryEntry | null,
  patch: Partial<Omit<MonitorRecord, "id">>,
): Promise<void> {
  await txMulti([STORES.monitors], "readwrite", (m) => {
    const store = m[STORES.monitors];
    const getReq = store.get(id) as IDBRequest<MonitorRecord | undefined>;
    getReq.onerror = () => store.transaction.abort();
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return;
      const history =
        entry == null ? existing.history : [...existing.history, entry].slice(-MONITOR_HISTORY_LIMIT);
      store.put({ ...existing, ...patch, history, id });
    };
  });
  publishChange(STORES.monitors, "put", id);
}

export async function deleteMonitorRec(id: string): Promise<void> {
  await tx<undefined>(STORES.monitors, "readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  publishChange(STORES.monitors, "remove", id);
}
