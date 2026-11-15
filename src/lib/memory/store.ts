// src/lib/memory/store.ts
//
// `memory` IDB store 的读写层（spec §5.6）。一个 store 里放多种记录形状，
// 用 `id` 前缀区分：
//   "m_<uuid>"   → MemoryEntry
//   "settings"   → MemorySettingsRecord（总开关 + 不记住的网站）
//   "state"      → MemoryStateRecord（水位线 / 上次整理 / 挑选计数）
//   "profile"    → MemoryProfileRecord（常驻画像）
//   "snapshot"   → MemorySnapshotRecord（精简前快照，只留上一份）
//   "undo_<id>"  → MemoryUndoRecord（对话里的可撤销记录）
//
// 「地址与联系方式」类条目（kind === "contact"）的 title/body 落盘前用
// crypto.ts 的 AES-GCM 加密（`encrypted: true`），读回时解密；界面按需打码。

import { tx, txMulti, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";
import { admitMemoryCandidate } from "./admission";
import { planExpireStaleRecent, planMemoryOps, type PlanResult } from "./ops";
import {
  MEMORY_RECENT_TTL_MS,
  type MemoryEntry,
  type MemoryEntryOrigin,
  type MemoryOp,
  type MemoryProfileRecord,
  type MemorySettingsRecord,
  type MemorySnapshotRecord,
  type MemoryStateRecord,
  type MemoryUndoRecord,
} from "./types";

const STORE = STORES.memory;
const ENTRY_PREFIX = "m_";
const UNDO_PREFIX = "undo_";

export const MEMORY_SETTINGS_ID = "settings";
export const MEMORY_STATE_ID = "state";
export const MEMORY_PROFILE_ID = "profile";
export const MEMORY_SNAPSHOT_ID = "snapshot";

const DEFAULT_SETTINGS: MemorySettingsRecord = {
  id: MEMORY_SETTINGS_ID,
  enabled: true,
  excludedDomains: [],
  historySource: false,
};

const DEFAULT_STATE: MemoryStateRecord = {
  id: MEMORY_STATE_ID,
  watermark: 0,
};

function isEntryRecord(r: { id: string }): r is MemoryEntry {
  return r.id.startsWith(ENTRY_PREFIX);
}

// ── 加密（「地址与联系方式」） ────────────────────────────────────────────────

/**
 * 把**明文**条目的「地址与联系方式」类 title/body 加密。所有写条目记录的调用方
 * 拿到的都是解密后的条目（listMemoryEntries / planMemoryOps 的产物），所以这里
 * 无条件加密——不要用 `encrypted` 标志判断「是否已加密」：解密后的条目仍然带着
 * `encrypted: true`（表示「这类条目是加密存储的」），按它跳过就会把明文写回库。
 * 唯一绕过本函数直接写记录的是快照 / undo 回放（它们存的就是密文）。
 */
async function sealEntry(e: MemoryEntry): Promise<MemoryEntry> {
  if (e.kind !== "contact") return e;
  const key = await getOrCreateEncryptionKey();
  return {
    ...e,
    title: await encrypt(e.title, key),
    body: await encrypt(e.body, key),
    encrypted: true,
  };
}

async function openEntry(raw: MemoryEntry): Promise<MemoryEntry> {
  if (!raw.encrypted) return raw;
  try {
    const key = await getOrCreateEncryptionKey();
    return {
      ...raw,
      title: await decrypt(raw.title, key),
      body: await decrypt(raw.body, key),
    };
  } catch {
    // 密钥变了（重装 / 清过 config）——不阻塞其它记忆，只把这一条标成不可读。
    // 文本留空由 UI 走字典文案；decryptFailed 让写回路径跳过它（密文原样保留）。
    return { ...raw, title: "", body: "", decryptFailed: true };
  }
}

// ── 基础读写 ────────────────────────────────────────────────────────────────

async function readAllRaw(): Promise<Array<Record<string, unknown>>> {
  return tx<Array<Record<string, unknown>>>(STORE, "readonly", (s) => s.getAll());
}

export async function getMemorySettings(): Promise<MemorySettingsRecord> {
  const rec = await tx<MemorySettingsRecord | undefined>(STORE, "readonly", (s) =>
    s.get(MEMORY_SETTINGS_ID),
  );
  return { ...DEFAULT_SETTINGS, ...(rec ?? {}) };
}

export async function setMemorySettings(
  patch: Partial<Pick<MemorySettingsRecord, "enabled" | "excludedDomains" | "historySource">>,
): Promise<MemorySettingsRecord> {
  const cur = await getMemorySettings();
  const next: MemorySettingsRecord = { ...cur, ...patch, id: MEMORY_SETTINGS_ID };
  await tx(STORE, "readwrite", (s) => s.put(next));
  publishChange("memory", "put", MEMORY_SETTINGS_ID);
  return next;
}

export async function getMemoryState(): Promise<MemoryStateRecord> {
  const rec = await tx<MemoryStateRecord | undefined>(STORE, "readonly", (s) =>
    s.get(MEMORY_STATE_ID),
  );
  return { ...DEFAULT_STATE, ...(rec ?? {}) };
}

export async function setMemoryState(patch: Partial<MemoryStateRecord>): Promise<void> {
  const cur = await getMemoryState();
  const next: MemoryStateRecord = { ...cur, ...patch, id: MEMORY_STATE_ID };
  await tx(STORE, "readwrite", (s) => s.put(next));
  publishChange("memory", "put", MEMORY_STATE_ID);
}

export async function getMemoryProfile(): Promise<MemoryProfileRecord> {
  const rec = await tx<MemoryProfileRecord | undefined>(STORE, "readonly", (s) =>
    s.get(MEMORY_PROFILE_ID),
  );
  return rec ?? { id: MEMORY_PROFILE_ID, text: "", updatedAt: 0 };
}

export async function setMemoryProfileText(text: string, now = Date.now()): Promise<void> {
  await tx(STORE, "readwrite", (s) =>
    s.put({ id: MEMORY_PROFILE_ID, text, updatedAt: now } satisfies MemoryProfileRecord),
  );
  publishChange("memory", "put", MEMORY_PROFILE_ID);
}

/**
 * 读全部记忆条目（解密后）。默认只返回有效条目（`validTo` 未置位）。
 * 记忆页「已过期」区用 `includeExpired: true`。
 */
export async function listMemoryEntries(
  opts: { includeExpired?: boolean } = {},
): Promise<MemoryEntry[]> {
  const all = await readAllRaw();
  const out: MemoryEntry[] = [];
  for (const r of all) {
    if (!isEntryRecord(r as { id: string })) continue;
    const raw = r as unknown as MemoryEntry;
    if (!opts.includeExpired && raw.validTo !== undefined) continue;
    out.push(await openEntry(raw));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getMemoryEntry(id: string): Promise<MemoryEntry | null> {
  const rec = await tx<MemoryEntry | undefined>(STORE, "readonly", (s) => s.get(id));
  return rec ? await openEntry(rec) : null;
}

async function writeEntries(
  entries: MemoryEntry[],
  deletedIds: string[],
): Promise<void> {
  const sealed = await Promise.all(entries.map(sealEntry));
  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const e of sealed) store.put(e);
    for (const id of deletedIds) store.delete(id);
  });
  publishChange("memory", "put");
}

/** 用户手动编辑一条（记忆页 F15）。 */
export async function updateMemoryEntry(
  id: string,
  patch: Pick<MemoryEntry, "title" | "body"> & { tags?: string[]; kind?: MemoryEntry["kind"] },
): Promise<boolean> {
  const cur = await getMemoryEntry(id);
  if (!cur) return false;
  const next: MemoryEntry = {
    ...cur,
    ...patch,
    updatedAt: Date.now(),
    origin: "user",
    pinned: true,
  };
  await writeEntries([next], []);
  return true;
}

export async function deleteMemoryEntries(
  ids: string[],
  now = Date.now(),
): Promise<{ count: number; eventId: string | null }> {
  if (ids.length === 0) return { count: 0, eventId: null };
  const all = await listMemoryEntries({ includeExpired: true });
  const before = all.filter((e) => ids.includes(e.id));
  if (before.length === 0) return { count: 0, eventId: null };
  const eventId = `${UNDO_PREFIX}${crypto.randomUUID()}`;
  // undo 记录里存**密文**（contact 条目不能因为被删除就把明文写回库）。
  await pushUndo({
    id: eventId,
    at: now,
    kind: "deleted",
    before: await Promise.all(before.map(sealEntry)),
    created: [],
  });
  await txMulti([STORE], "readwrite", (m) => {
    for (const e of before) m[STORE].delete(e.id);
  });
  publishChange("memory", "put");
  return { count: before.length, eventId };
}

/** 清空全部记忆（含快照 / 撤销记录），保留「不记住的网站」、开关与设备 sync 元信息。 */
export async function clearAllMemory(opts?: { cloudRevision?: number }): Promise<void> {
  const [settings, prevState] = await Promise.all([getMemorySettings(), getMemoryState()]);
  await txMulti([STORE], "readwrite", (m) => {
    m[STORE].clear();
    m[STORE].put(settings);
    const nextState: MemoryStateRecord = {
      id: MEMORY_STATE_ID,
      watermark: prevState.watermark,
      ...(prevState.deviceId ? { deviceId: prevState.deviceId } : {}),
      ...(prevState.digestWatermark !== undefined ? { digestWatermark: prevState.digestWatermark } : {}),
      ...(prevState.lastHistoryDigestAt !== undefined
        ? { lastHistoryDigestAt: prevState.lastHistoryDigestAt }
        : {}),
      ...(prevState.cloudImported !== undefined ? { cloudImported: prevState.cloudImported } : {}),
      ...(prevState.firstConsolidationNoticeShown !== undefined
        ? { firstConsolidationNoticeShown: prevState.firstConsolidationNoticeShown }
        : {}),
      ...(opts?.cloudRevision !== undefined
        ? { cloudRevision: opts.cloudRevision }
        : prevState.cloudRevision !== undefined
          ? { cloudRevision: prevState.cloudRevision }
          : {}),
      hasCloudSnapshot: false,
    };
    m[STORE].put(nextState);
  });
  publishChange("memory", "clear");
}

export interface MirrorCloudSnapshotInput {
  revision: number;
  readOnly: boolean;
  settings: { enabled: boolean; excludedDomains: string[] };
  profile: { text: string; updatedAt: number };
  state: {
    lastConsolidatedAt?: number;
    lastCompactedAt?: number;
    lastSummary?: MemoryStateRecord["lastSummary"];
    hasSnapshot?: boolean;
  };
  entries: MemoryEntry[];
}

/**
 * 将云端下发的权威快照原子写入本地 IDB 镜像（`contact` 重新用本机密钥加密，
 * 保留设备本地的 `historySource` / `deviceId` / `digestWatermark`）。
 */
export async function replaceLocalMemoryMirror(
  snapshot: MirrorCloudSnapshotInput,
): Promise<void> {
  const [allRaw, prevSettings, prevState] = await Promise.all([
    readAllRaw(),
    getMemorySettings(),
    getMemoryState(),
  ]);
  const existingIds = allRaw
    .filter((r) => isEntryRecord(r as { id: string }))
    .map((r) => String(r.id));
  const incomingIds = new Set(snapshot.entries.map((e) => e.id));
  const deleteIds = existingIds.filter((id) => !incomingIds.has(id));
  const sealed = await Promise.all(snapshot.entries.map(sealEntry));

  const nextSettings: MemorySettingsRecord = {
    id: MEMORY_SETTINGS_ID,
    enabled: snapshot.settings.enabled,
    excludedDomains: snapshot.settings.excludedDomains,
    historySource: prevSettings.historySource === true,
  };

  const hasContent =
    snapshot.entries.length > 0 || snapshot.profile.text.trim().length > 0;
  const shouldTriggerBanner =
    !snapshot.readOnly &&
    !prevState.firstConsolidationNoticeShown &&
    snapshot.state.lastConsolidatedAt !== undefined &&
    hasContent;

  const nextState: MemoryStateRecord = {
    ...prevState,
    id: MEMORY_STATE_ID,
    cloudRevision: snapshot.revision,
    cloudReadOnly: snapshot.readOnly,
    hasCloudSnapshot: snapshot.state.hasSnapshot === true,
    ...(snapshot.state.lastConsolidatedAt !== undefined
      ? { lastConsolidatedAt: snapshot.state.lastConsolidatedAt }
      : { lastConsolidatedAt: undefined }),
    ...(snapshot.state.lastCompactedAt !== undefined
      ? { lastCompactedAt: snapshot.state.lastCompactedAt }
      : { lastCompactedAt: undefined }),
    ...(snapshot.state.lastSummary !== undefined
      ? { lastSummary: snapshot.state.lastSummary }
      : { lastSummary: undefined }),
    ...(shouldTriggerBanner ? { firstConsolidationPendingBanner: true } : {}),
  };

  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const id of deleteIds) store.delete(id);
    for (const e of sealed) store.put(e);
    store.put(nextSettings);
    store.put({
      id: MEMORY_PROFILE_ID,
      text: snapshot.profile.text,
      updatedAt: snapshot.profile.updatedAt,
    } satisfies MemoryProfileRecord);
    store.put(nextState);
  });
  publishChange("memory", "put");
}

/** Write-through：云端 remember / edit 返回新条目后即时更新本地镜像。 */
export async function upsertLocalMirroredEntry(
  entry: MemoryEntry,
  cloudRevision?: number,
): Promise<void> {
  const sealed = await sealEntry(entry);
  const prevState = await getMemoryState();
  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    store.put(sealed);
    if (cloudRevision !== undefined) {
      store.put({
        ...prevState,
        id: MEMORY_STATE_ID,
        cloudRevision,
      } satisfies MemoryStateRecord);
    }
  });
  publishChange("memory", "put", entry.id);
}

/** Write-through：云端 forget / delete 返回删除 ID 后即时更新本地镜像。 */
export async function removeLocalMirroredEntries(
  ids: string[],
  cloudRevision?: number,
): Promise<void> {
  if (ids.length === 0 && cloudRevision === undefined) return;
  const prevState = await getMemoryState();
  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const id of ids) store.delete(id);
    if (cloudRevision !== undefined) {
      store.put({
        ...prevState,
        id: MEMORY_STATE_ID,
        cloudRevision,
      } satisfies MemoryStateRecord);
    }
  });
  publishChange("memory", "put");
}

/** 关闭或跳转后标记首次整理顶部提示已消费，避免再弹出。 */
export async function dismissFirstConsolidationNotice(): Promise<void> {
  await setMemoryState({
    firstConsolidationPendingBanner: false,
    firstConsolidationNoticeShown: true,
  });
}

export interface MemoryExport {
  version: 1;
  exportedAt: number;
  enabled: boolean;
  excludedDomains: string[];
  profile: string;
  entries: Array<Omit<MemoryEntry, "encrypted">>;
}

/** 导出为 JSON（spec: 导出为 JSON；密文条目包含明文，导出文件本身是用户自己的）。 */
export async function exportMemory(now = Date.now()): Promise<MemoryExport> {
  const [settings, profile, entries] = await Promise.all([
    getMemorySettings(),
    getMemoryProfile(),
    listMemoryEntries({ includeExpired: true }),
  ]);
  return {
    version: 1,
    exportedAt: now,
    enabled: settings.enabled,
    excludedDomains: settings.excludedDomains,
    profile: profile.text,
    entries: entries.map(({ encrypted: _e, ...rest }) => rest),
  };
}

// ── 使用计数 ────────────────────────────────────────────────────────────────

/** 被挑选注入的条目：useCount + lastUsedAt（精简时决定留谁的依据）。 */
export async function recordMemoryUsage(ids: string[], now = Date.now()): Promise<void> {
  if (ids.length === 0) return;
  const all = await listMemoryEntries();
  const hit = all.filter((e) => ids.includes(e.id));
  if (hit.length === 0) return;
  await writeEntries(
    hit.map((e) => ({ ...e, useCount: e.useCount + 1, lastUsedAt: now })),
    [],
  );
}

// ── 操作序列（整理 / 精简） ──────────────────────────────────────────────────

export interface ApplyOpsOptions {
  origin: MemoryEntryOrigin;
  now?: number;
  /**
   * 与条目写入同一事务提交的状态补丁。传函数时以计划结果为入参（例如要把
   * 本次整理的精确计数写进 lastSummary）。
   */
  statePatch?:
    | Partial<MemoryStateRecord>
    | ((plan: PlanResult) => Partial<MemoryStateRecord>);
}

/**
 * 应用一份操作序列：**一次 txMulti 原子写入**（spec §5.4）。
 * 任何一步抛错整批回滚，水位线也不前进 → 下次心跳重做这一批。
 */
export async function applyMemoryOps(
  ops: MemoryOp[],
  opts: ApplyOpsOptions,
): Promise<PlanResult> {
  const now = opts.now ?? Date.now();
  const current = await listMemoryEntries({ includeExpired: true });
  const plan = planMemoryOps(current, ops, { now, origin: opts.origin });
  // 解不开的密文条目原样留在库里：写回只有空文本，会把用户数据抹掉。
  const sealed = await Promise.all(
    plan.entries.filter((e) => !e.decryptFailed).map(sealEntry),
  );

  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const e of sealed) store.put(e);
    for (const id of plan.deletedIds) store.delete(id);
    if (plan.profileText !== undefined) {
      store.put({
        id: MEMORY_PROFILE_ID,
        text: plan.profileText,
        updatedAt: now,
      } satisfies MemoryProfileRecord);
    }
    if (opts.statePatch) {
      const patch =
        typeof opts.statePatch === "function" ? opts.statePatch(plan) : opts.statePatch;
      // 读-改-写同一个事务内：state 是单例记录，这里直接覆盖已知字段。
      const req = store.get(MEMORY_STATE_ID);
      req.onsuccess = () => {
        const prev = (req.result as MemoryStateRecord | undefined) ?? DEFAULT_STATE;
        store.put({ ...prev, ...patch, id: MEMORY_STATE_ID });
      };
    }
  });
  publishChange("memory", "put");
  return plan;
}

/** 清掉 30 天没用过的近期片段（月度精简的一部分）。 */
export async function expireStaleRecent(now = Date.now()): Promise<string[]> {
  const entries = await listMemoryEntries();
  const ids = planExpireStaleRecent(entries, now, MEMORY_RECENT_TTL_MS);
  if (ids.length === 0) return ids;
  await txMulti([STORE], "readwrite", (m) => {
    for (const id of ids) m[STORE].delete(id);
  });
  publishChange("memory", "put");
  return ids;
}

// ── 快照 / 撤销 ─────────────────────────────────────────────────────────────

/** 精简前存一份完整快照（只保留上一份）。 */
export async function saveMemorySnapshot(now = Date.now()): Promise<void> {
  const [allRaw, profile] = await Promise.all([
    readAllRaw(),
    getMemoryProfile(),
  ]);
  const entries = allRaw.filter((r) => isEntryRecord(r as { id: string })) as unknown as MemoryEntry[];
  const snap: MemorySnapshotRecord = {
    id: MEMORY_SNAPSHOT_ID,
    at: now,
    profileText: profile.text,
    entries,
  };
  await tx(STORE, "readwrite", (s) => s.put(snap));
  publishChange("memory", "put", MEMORY_SNAPSHOT_ID);
}

export async function getMemorySnapshot(): Promise<MemorySnapshotRecord | null> {
  const rec = await tx<MemorySnapshotRecord | undefined>(STORE, "readonly", (s) =>
    s.get(MEMORY_SNAPSHOT_ID),
  );
  return rec ?? null;
}

/** 撤销本次精简：整库条目回到快照，快照本身清掉（只能撤一次）。 */
export async function restoreMemorySnapshot(): Promise<boolean> {
  const [snap, current] = await Promise.all([getMemorySnapshot(), readAllRaw()]);
  if (!snap) return false;
  const keep = new Set(snap.entries.map((e) => e.id));
  const extra = current
    .filter((r) => isEntryRecord(r as { id: string }) && !keep.has((r as { id: string }).id))
    .map((r) => (r as { id: string }).id);
  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const id of extra) store.delete(id);
    for (const e of snap.entries) store.put(e);
    store.put({
      id: MEMORY_PROFILE_ID,
      text: snap.profileText,
      updatedAt: Date.now(),
    } satisfies MemoryProfileRecord);
    store.delete(MEMORY_SNAPSHOT_ID);
  });
  publishChange("memory", "put");
  return true;
}

/** 存一条可撤销记录（F13）。保留最近 1 小时、最多 20 条。 */
async function pushUndo(rec: MemoryUndoRecord): Promise<void> {
  const all = await readAllRaw();
  const stale = all
    .filter((r) => String(r.id).startsWith(UNDO_PREFIX))
    .map((r) => r as unknown as MemoryUndoRecord)
    .filter((r) => rec.at - r.at > 60 * 60 * 1000)
    .map((r) => r.id);
  await txMulti([STORE], "readwrite", (m) => {
    m[STORE].put(rec);
    for (const id of stale) m[STORE].delete(id);
  });
}

export interface UndoOutcome {
  ok: boolean;
  kind?: MemoryUndoRecord["kind"];
}

/** 撤销一次 remember / forget（对话里那条事件行的「撤销」）。 */
export async function undoMemoryEvent(eventId: string): Promise<UndoOutcome> {
  const rec = await tx<MemoryUndoRecord | undefined>(STORE, "readonly", (s) =>
    s.get(eventId),
  );
  if (!rec) return { ok: false };
  // `before` 在写入时已 seal（contact 条目是密文），直接原样写回即可。
  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const id of rec.created) store.delete(id);
    for (const e of rec.before) store.put(e);
    store.delete(eventId);
  });
  publishChange("memory", "put");
  return { ok: true, kind: rec.kind };
}

/**
 * `remember` 工具用：写入一条显式记忆（同标题同类别视为更新），
 * 并留下可撤销记录。返回事件行要展示的摘要。
 */
export async function rememberEntry(input: {
  kind: MemoryEntry["kind"];
  title: string;
  body: string;
  tags?: string[];
  now?: number;
  sourceSessionId?: string;
}): Promise<
  | { ok: false; reason: string }
  | {
      ok: true;
      id: string;
      event: { eventId: string; kind: "updated"; label: string; encrypted?: boolean };
    }
> {
  const now = input.now ?? Date.now();
  // 先做一次准入，把被拒的原因（secret / empty）如实带回给工具层。
  const admitted = admitMemoryCandidate(
    { kind: input.kind, title: input.title, body: input.body, tags: input.tags },
    { origin: "explicit" },
  );
  if (!admitted.ok) return { ok: false, reason: admitted.reason };
  const current = await listMemoryEntries({ includeExpired: true });
  const plan = planMemoryOps(
    current,
    [
      {
        op: "add",
        kind: input.kind,
        title: input.title,
        body: input.body,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.sourceSessionId ? { source_session: input.sourceSessionId } : {}),
      },
    ],
    { now, origin: "explicit" },
  );
  const changed = plan.entries.find((e) => plan.changedIds.includes(e.id));
  if (!changed || plan.changedIds.length === 0) {
    return { ok: false, reason: "not_admitted" };
  }
  const pinned: MemoryEntry = { ...changed, pinned: true, origin: "explicit" };
  // 覆盖前旧值（用于撤销）——存密文，避免 contact 条目的明文写回库。
  const before = current.filter((e) => e.id === pinned.id);
  const sealedBefore = await Promise.all(before.map(sealEntry));
  const eventId = `${UNDO_PREFIX}${crypto.randomUUID()}`;
  const sealed = await Promise.all([pinned].map(sealEntry));
  await txMulti([STORE], "readwrite", (m) => {
    const store = m[STORE];
    for (const e of sealed) store.put(e);
    for (const id of plan.deletedIds) store.delete(id);
    store.put({
      id: eventId,
      at: now,
      kind: "updated",
      before: sealedBefore,
      created: before.length === 0 ? [pinned.id] : [],
    } satisfies MemoryUndoRecord);
  });
  publishChange("memory", "put");
  return {
    ok: true,
    id: pinned.id,
    event: {
      eventId,
      kind: "updated",
      // 「地址与联系方式」类条目的标题也加密存——事件行（和它的持久化副本）
      // 只给空标题 + encrypted 标记，由面板按当前语言渲染占位文案：
      // 明文既不进对话历史，也不会以中文写死在 SW 里。
      label: pinned.encrypted ? "" : pinned.title,
      ...(pinned.encrypted ? { encrypted: true } : {}),
    },
  };
}
