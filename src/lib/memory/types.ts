// src/lib/memory/types.ts
//
// Pie 2.0 记忆层（spec §5）的数据模型与容量常量。
//
// 三层结构（spec §5.2）：
//   Profile  常驻短文（≤ ~1000 token），每个任务都带；
//   Index    每条记忆一行，只给挑选模型看；
//   Entry    正文，被选中的才注入。
//
// 「近期片段」（kind="recent"）是每日整理出的碎片，月度精简时合并进长期或清除。

export const MEMORY_KINDS = [
  "about", // 关于你
  "preference", // 偏好与习惯
  "contact", // 地址与联系方式（落盘加密）
  "site", // 常用网站与账号
  "ongoing", // 进行中的事
  "recent", // 近期片段
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 长期记忆类别（其余为「近期片段」）。 */
export const LONG_TERM_KINDS: readonly MemoryKind[] = [
  "about",
  "preference",
  "contact",
  "site",
  "ongoing",
];

// ── 容量（spec §10 #4） ──────────────────────────────────────────────────────
/** 全部记忆正文总字数上限（约 25k token）。 */
export const MEMORY_MAX_CHARS = 20_000;
/** 长期条目数上限。 */
export const MEMORY_LONG_TERM_MAX = 300;
/** 近期片段条数上限。 */
export const MEMORY_RECENT_MAX = 200;
/** 索引硬上限（超过时先做规则预筛再交给挑选模型）。 */
export const MEMORY_INDEX_MAX = 500;
/** 单条正文上限（约 200 token）。 */
export const MEMORY_BODY_MAX_CHARS = 400;
/** 单条标题上限。 */
export const MEMORY_TITLE_MAX_CHARS = 60;
/** 画像上限（约 1000 token）。 */
export const MEMORY_PROFILE_MAX_CHARS = 2_000;
/** 近期片段 30 天未被用到就清除。 */
export const MEMORY_RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 每日整理的最小间隔（水位线之外的第二道闸）。 */
export const MEMORY_CONSOLIDATE_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** 容量超过该比例时提前触发月度精简。 */
export const MEMORY_COMPACT_EARLY_RATIO = 0.9;
/** 每次挑选最多返回条数。 */
export const MEMORY_PICK_MAX = 8;
/** 筛选软超时 / 硬超时（spec §5.5）。 */
export const MEMORY_PICK_SOFT_TIMEOUT_MS = 2_500;
export const MEMORY_PICK_HARD_TIMEOUT_MS = 4_000;
/** 每个用户每日挑选调用上限。 */
export const MEMORY_PICK_DAILY_CAP = 200;

export type MemoryEntryOrigin = "explicit" | "consolidated" | "user";

export interface MemoryEntry {
  /** "m_<uuid>" */
  id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** 事实有效期起点。 */
  validFrom: number;
  /** 被新事实取代时置位；置位条目不再注入 / 不再进索引。 */
  validTo?: number;
  useCount: number;
  lastUsedAt?: number;
  sourceSessionId?: string;
  sourceTitle?: string;
  /** 用户在记忆页手动编辑 / 显式 remember 的条目，不自动淘汰。 */
  pinned?: boolean;
  origin: MemoryEntryOrigin;
  /** true = title/body 是 AES-GCM 密文（「地址与联系方式」类）。 */
  encrypted?: boolean;
}

/** 落盘记录（未知字段被忽略；`id` 是 store 的 keyPath）。 */
export interface MemorySettingsRecord {
  id: "settings";
  /** 自动记忆总开关（F14 顶部）。 */
  enabled: boolean;
  /** 不记住的网站（域名列表）。 */
  excludedDomains: string[];
}

export interface ConsolidationSummary {
  at: number;
  added: number;
  updated: number;
  merged: number;
  expired: number;
  deleted: number;
  profileRewritten: boolean;
}

export interface MemoryStateRecord {
  id: "state";
  /** 上次整理处理到哪（会话 lastAccessedAt 水位线）。 */
  watermark: number;
  lastConsolidatedAt?: number;
  lastCompactedAt?: number;
  lastSummary?: ConsolidationSummary;
  /** 当日挑选调用计数（每日上限）。 */
  pick?: { date: string; count: number };
}

export interface MemoryProfileRecord {
  id: "profile";
  text: string;
  updatedAt: number;
}

export interface MemorySnapshotRecord {
  id: "snapshot";
  at: number;
  profileText: string;
  /** 密文原样保存（读回时按需解密）。 */
  entries: MemoryEntry[];
}

/** 可撤销记录（F13「撤销」）。值在删除 / 覆盖前抓取，撤销即写回。 */
export interface MemoryUndoRecord {
  /** "undo_<uuid>" */
  id: string;
  at: number;
  kind: "updated" | "deleted";
  /** 覆盖前的旧值（restore 用）。 */
  before: MemoryEntry[];
  /** 新建出来的 id（undo `remember` 时删掉）。 */
  created: string[];
}

export type MemoryRecord =
  | MemoryEntry
  | MemorySettingsRecord
  | MemoryStateRecord
  | MemoryProfileRecord
  | MemorySnapshotRecord
  | MemoryUndoRecord;

// ── 整理操作序列（spec §5.4） ────────────────────────────────────────────────

export type MemoryOp =
  | {
      op: "add";
      kind: MemoryKind;
      title: string;
      body: string;
      tags?: string[];
      source_session?: string;
    }
  | {
      op: "update";
      id: string;
      patch: { title?: string; body?: string; tags?: string[]; kind?: MemoryKind };
      reason?: string;
    }
  | {
      op: "merge";
      ids: string[];
      title: string;
      body: string;
      tags?: string[];
      kind?: MemoryKind;
    }
  | { op: "expire"; id: string }
  | { op: "delete"; id: string }
  | { op: "profile"; text: string };

/** 一次整理 / 精简的完整计划。 */
export interface MemoryOpBatch {
  ops: MemoryOp[];
}
