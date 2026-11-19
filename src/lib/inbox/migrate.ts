// src/lib/inbox/migrate.ts
//
// §6 — 「定时任务现有的 unread 迁移到 inbox」。
//
// Before Pie 2.0 a schedule run that the user never looked at carried
// `unread: true` on its ScheduleRunRecord. The activity feed replaces that
// flag, so on first boot after the upgrade every such run becomes one
// `needs_action` entry.
//
// Idempotent by construction: entry ids are derived from the run recordId, and
// a `config` flag short-circuits the whole scan on later boots (the scan reads
// every run record, which is cheap but pointless to repeat).

import { listSchedules } from "@/lib/schedules/store";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import { tx, STORES } from "@/lib/idb/db";
import { addInboxEntry } from "./store";
import type { ScheduleRecord, ScheduleRunRecord } from "@/lib/schedules/types";

const MIGRATION_FLAG = "inbox_unread_migrated_v1";

/** All ScheduleRunRecords (run_* keys), phantom `id` stripped. */
async function listAllRuns(): Promise<ScheduleRunRecord[]> {
  const all = await tx<(ScheduleRunRecord & { id?: string })[]>(
    STORES.schedules,
    "readonly",
    (s) => {
      const range = IDBKeyRange.bound("run_", "run_￿");
      return s.getAll(range) as IDBRequest<(ScheduleRunRecord & { id?: string })[]>;
    },
  );
  return all.map(({ id: _id, ...rest }) => rest as ScheduleRunRecord);
}

export async function migrateScheduleUnreadToInbox(): Promise<number> {
  if ((await getConfig<boolean>(MIGRATION_FLAG)) === true) return 0;

  const [runs, schedules] = await Promise.all([listAllRuns(), listSchedules()]);
  const titleById = new Map<string, string>(
    schedules.map((s: ScheduleRecord) => [s.id, s.title]),
  );

  let migrated = 0;
  for (const run of runs) {
    if (!run.unread) continue;
    await addInboxEntry({
      // Deterministic id → re-running this migration cannot duplicate rows.
      id: `ibx_unread_${run.recordId}`,
      source: "schedule",
      refId: run.recordId,
      kind: "needs_action",
      title: titleById.get(run.scheduleId) ?? run.scheduleId,
      body: run.summary ?? run.error ?? "",
      data: { status: run.status, sessionId: run.sessionId ?? "" },
      at: run.endedAt ?? run.startedAt,
      read: false,
    });
    migrated++;
  }

  await setConfig(MIGRATION_FLAG, true);
  return migrated;
}
