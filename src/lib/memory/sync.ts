// src/lib/memory/sync.ts
//
// Pie Pro 记忆多设备云端同步协调器与写穿门面：
//   - pull: GET /memory?sinceRevision=n，与云端 revision 一致则 O(1) 返回；
//   - import: 本地已有开发期/离线记忆且云端 revision === 0 时，一次性 POST /memory/import 迁移上云；
//   - write-through: 订阅态下所有写操作（remember/forget/edit/delete/undo/restore/settings/clear）
//     都先写云端权威源，再写穿本地 IDB 镜像；订阅到期仅允许查看、导出、彻底清空。

import { getMemoryAccessState, getManagedMemoryApiKey, isMemoryWritableAccess } from "./access";
import {
  cloudClearAllMemory,
  cloudDeleteMemoryEntries,
  cloudForgetMemory,
  cloudImportMemory,
  cloudRememberEntry,
  cloudRestoreMemorySnapshot,
  cloudUndoMemoryEvent,
  cloudUpdateMemoryEntry,
  patchCloudMemorySettings,
  pullCloudMemory,
  type CloudMemoryPullResult,
  type MemoryCloudDeps,
} from "./cloud";
import { memoryRequiresSubscription } from "./model";
import {
  clearAllMemory,
  deleteMemoryEntries,
  getMemoryProfile,
  getMemorySettings,
  getMemoryState,
  listMemoryEntries,
  rememberEntry,
  removeLocalMirroredEntries,
  replaceLocalMemoryMirror,
  setMemorySettings,
  setMemoryState,
  undoMemoryEvent,
  updateMemoryEntry,
  upsertLocalMirroredEntry,
  type UndoOutcome,
} from "./store";
import type { MemoryEntry, MemoryKind, MemorySettingsRecord } from "./types";

const SYNC_THROTTLE_MS = 20_000;

let lastSyncAttemptAt = 0;
let inFlightSync: Promise<CloudMemoryPullResult | null> | null = null;

/** Test-only：重置节流时间戳与并发锁。 */
export function _resetMemorySyncForTests(): void {
  lastSyncAttemptAt = 0;
  inFlightSync = null;
}

export interface SyncMemoryOptions {
  /** 跳过 20s 节流，传 true 时强制向服务端校准（页面打开 / 每小时心跳 / undo 后用）。 */
  force?: boolean;
  deps?: MemoryCloudDeps;
  now?: number;
}

async function runSyncOnce(opts: SyncMemoryOptions): Promise<CloudMemoryPullResult | null> {
  if (!memoryRequiresSubscription()) return null;

  const access = await getMemoryAccessState();
  const apiKey =
    access.mode === "cloud_active"
      ? access.apiKey
      : access.mode === "readonly_expired" || access.mode === "locked"
        ? access.apiKey
        : await getManagedMemoryApiKey();
  if (!apiKey) return null;

  const prevState = await getMemoryState();
  const deps = opts.deps;

  // 一次性迁移：本地在订阅上线前已有开发期记忆、且云端尚未建立版本（revision === 0）时，
  // 首次登录 Pro 自动将存量迁移上云，避免首次 pull 冲掉本地数据。
  if (access.mode === "cloud_active" && !prevState.cloudImported) {
    const firstPull = await pullCloudMemory(apiKey, undefined, deps);
    if (
      !firstPull.unchanged &&
      firstPull.revision === 0 &&
      firstPull.entries.length === 0 &&
      !firstPull.profile.text.trim()
    ) {
      const [localEntries, localProfile, localSettings] = await Promise.all([
        listMemoryEntries({ includeExpired: true }),
        getMemoryProfile(),
        getMemorySettings(),
      ]);
      const hasLocalData =
        localEntries.length > 0 || localProfile.text.trim().length > 0;
      if (hasLocalData) {
        const imported = await cloudImportMemory(
          apiKey,
          {
            profileText: localProfile.text,
            entries: localEntries,
            settings: {
              enabled: localSettings.enabled,
              excludedDomains: localSettings.excludedDomains,
            },
          },
          deps,
        );
        await setMemoryState({ cloudImported: true });
        await replaceLocalMemoryMirror(imported);
        return imported;
      }
    }
    await setMemoryState({ cloudImported: true });
    if (!firstPull.unchanged) {
      await replaceLocalMemoryMirror(firstPull);
    }
    return firstPull;
  }

  const sinceRevision = opts.force ? undefined : prevState.cloudRevision;
  const res = await pullCloudMemory(apiKey, sinceRevision, deps);
  if (res.unchanged) {
    if (prevState.cloudReadOnly !== res.readOnly) {
      await setMemoryState({ cloudReadOnly: res.readOnly });
    }
    return res;
  }

  // 到期用户尚未向云端同步过数据时，不应用空的 revision=0 抹掉本地存量记忆（保留只读可见）。
  if (
    res.readOnly &&
    res.revision === 0 &&
    res.entries.length === 0 &&
    !res.profile.text.trim() &&
    prevState.cloudRevision === undefined
  ) {
    const [localEntries, localProfile] = await Promise.all([
      listMemoryEntries({ includeExpired: true }),
      getMemoryProfile(),
    ]);
    if (localEntries.length > 0 || localProfile.text.trim().length > 0) {
      await setMemoryState({ cloudReadOnly: true });
      return res;
    }
  }

  await replaceLocalMemoryMirror(res);
  return res;
}

export async function syncMemoryFromCloud(
  opts: SyncMemoryOptions = {},
): Promise<CloudMemoryPullResult | null> {
  if (!memoryRequiresSubscription()) return null;
  if (inFlightSync) return inFlightSync;
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastSyncAttemptAt < SYNC_THROTTLE_MS) {
    return null;
  }
  lastSyncAttemptAt = now;
  const job = runSyncOnce(opts).finally(() => {
    if (inFlightSync === job) inFlightSync = null;
  });
  inFlightSync = job;
  return job;
}

export async function syncSetMemorySettings(
  patch: Partial<Pick<MemorySettingsRecord, "enabled" | "excludedDomains" | "historySource">>,
  deps: MemoryCloudDeps = {},
): Promise<MemorySettingsRecord> {
  const access = await getMemoryAccessState();
  if (access.mode === "local_dev") {
    return setMemorySettings(patch);
  }
  if (access.mode !== "cloud_active") {
    throw new Error("Memory settings cannot be changed without an active Pie Pro subscription.");
  }

  const localOnlyPatch =
    patch.historySource !== undefined ? { historySource: patch.historySource } : {};
  const cloudPatch: { enabled?: boolean; excludedDomains?: string[] } = {};
  if (patch.enabled !== undefined) cloudPatch.enabled = patch.enabled;
  if (patch.excludedDomains !== undefined) cloudPatch.excludedDomains = patch.excludedDomains;

  if (cloudPatch.enabled !== undefined || cloudPatch.excludedDomains !== undefined) {
    const res = await patchCloudMemorySettings(access.apiKey, cloudPatch, deps);
    const saved = await setMemorySettings({
      ...localOnlyPatch,
      enabled: res.settings.enabled,
      excludedDomains: res.settings.excludedDomains,
    });
    await setMemoryState({ cloudRevision: res.revision });
    return saved;
  }

  return setMemorySettings(localOnlyPatch);
}

export async function syncRememberEntry(
  input: {
    kind: MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    now?: number;
    sourceSessionId?: string;
    sourceTitle?: string;
  },
  deps: MemoryCloudDeps = {},
): Promise<
  | { ok: false; reason: string }
  | {
      ok: true;
      id: string;
      event: { eventId: string; kind: "updated"; label: string; encrypted?: boolean };
    }
> {
  const access = await getMemoryAccessState();
  if (access.mode === "local_dev") {
    return rememberEntry(input);
  }
  if (access.mode !== "cloud_active") {
    return { ok: false, reason: "subscription_required" };
  }

  const res = await cloudRememberEntry(
    access.apiKey,
    {
      kind: input.kind,
      title: input.title,
      body: input.body,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceTitle ? { sourceTitle: input.sourceTitle } : {}),
    },
    deps,
  );
  if (!res.ok) return res;
  await upsertLocalMirroredEntry(res.entry, res.revision);
  return { ok: true, id: res.id, event: res.event };
}

export async function syncForgetMemory(
  input: { id?: string; query?: string },
  deps: MemoryCloudDeps = {},
): Promise<{
  count: number;
  eventId: string | null;
  label: string;
  deletedIds: string[];
}> {
  const access = await getMemoryAccessState();
  if (access.mode === "local_dev") {
    const entries = await listMemoryEntries({ includeExpired: true });
    const id = input.id?.trim() ?? "";
    const query = input.query?.trim().toLowerCase() ?? "";
    const matches = id
      ? entries.filter((e) => e.id === id)
      : entries.filter((e) => {
          const hay = `${e.title} ${e.body} ${e.tags.join(" ")}`.toLowerCase();
          return hay.includes(query);
        });
    if (matches.length === 0) {
      return { count: 0, eventId: null, label: "", deletedIds: [] };
    }
    const { count, eventId } = await deleteMemoryEntries(matches.map((e) => e.id));
    const label = matches.length === 1 && !matches[0]!.encrypted ? matches[0]!.title : "";
    return { count, eventId, label, deletedIds: matches.map((e) => e.id) };
  }
  if (access.mode !== "cloud_active") {
    return { count: 0, eventId: null, label: "", deletedIds: [] };
  }

  const res = await cloudForgetMemory(access.apiKey, input, deps);
  if (res.deletedIds.length > 0 || res.count > 0) {
    await removeLocalMirroredEntries(res.deletedIds, res.revision);
  } else {
    await setMemoryState({ cloudRevision: res.revision });
  }
  return {
    count: res.count,
    eventId: res.eventId,
    label: res.label,
    deletedIds: res.deletedIds,
  };
}

export async function syncUpdateMemoryEntry(
  id: string,
  patch: Pick<MemoryEntry, "title" | "body"> & { tags?: string[]; kind?: MemoryKind },
  deps: MemoryCloudDeps = {},
): Promise<boolean> {
  const access = await getMemoryAccessState();
  if (access.mode === "local_dev") {
    return updateMemoryEntry(id, patch);
  }
  if (access.mode !== "cloud_active") return false;

  const res = await cloudUpdateMemoryEntry(access.apiKey, id, patch, deps);
  if (!res.ok) return false;
  if (res.entry) {
    await upsertLocalMirroredEntry(res.entry, res.revision);
  } else {
    await syncMemoryFromCloud({ force: true, deps });
  }
  return true;
}

export async function syncDeleteMemoryEntries(
  ids: string[],
  deps: MemoryCloudDeps = {},
): Promise<{ count: number; eventId: string | null }> {
  const access = await getMemoryAccessState();
  if (access.mode === "local_dev") {
    return deleteMemoryEntries(ids);
  }
  if (access.mode !== "cloud_active") return { count: 0, eventId: null };

  const res = await cloudDeleteMemoryEntries(access.apiKey, ids, deps);
  await removeLocalMirroredEntries(ids, res.revision);
  return { count: res.count, eventId: res.eventId };
}

export async function syncUndoMemoryEvent(
  eventId: string,
  deps: MemoryCloudDeps = {},
): Promise<UndoOutcome> {
  const access = await getMemoryAccessState();
  if (access.mode === "local_dev") {
    return undoMemoryEvent(eventId);
  }
  if (access.mode !== "cloud_active") return { ok: false };

  const res = await cloudUndoMemoryEvent(access.apiKey, eventId, deps);
  if (!res.ok) return { ok: false };
  await syncMemoryFromCloud({ force: true, deps }).catch(() => null);
  return { ok: true, ...(res.kind ? { kind: res.kind } : {}) };
}

export async function syncRestoreMemorySnapshot(
  deps: MemoryCloudDeps = {},
): Promise<boolean> {
  const access = await getMemoryAccessState();
  if (access.mode !== "cloud_active") return false;

  const res = await cloudRestoreMemorySnapshot(access.apiKey, deps);
  if (!res.ok) return false;
  await syncMemoryFromCloud({ force: true, deps }).catch(() => null);
  return true;
}

/**
 * 清空全部记忆：订阅到期只读保留态同样放行（用户删除权），有云端账号时同时清理云端。
 */
export async function syncClearAllMemory(
  deps: MemoryCloudDeps = {},
): Promise<void> {
  if (!memoryRequiresSubscription()) {
    await clearAllMemory();
    return;
  }
  const apiKey = await getManagedMemoryApiKey();
  if (apiKey) {
    const res = await cloudClearAllMemory(apiKey, deps);
    await clearAllMemory({ cloudRevision: res.revision });
    return;
  }
  await clearAllMemory();
}
