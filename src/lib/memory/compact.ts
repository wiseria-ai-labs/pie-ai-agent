// src/lib/memory/compact.ts
//
// 月度精简（spec §5.4）：
//   - 每月 1 日后的第一个心跳触发；容量超过 90% 时提前触发；
//   - 按实体聚类合并、从近期片段提炼长期偏好、删除 90 天未使用的单条、
//     重写画像、重建索引；
//   - **精简前**保留一份完整快照（只留上一份），供「撤销本次精简」。

import type { ModelConfig } from "@/lib/model-router";
import { callMemoryModel, resolveMemoryModel } from "./model";
import {
  buildCompactionUserPrompt,
  MEMORY_COMPACTION_SYSTEM_PROMPT,
} from "./prompt";
import { parseMemoryOps } from "./parse";
import {
  applyMemoryOps,
  expireStaleRecent,
  getMemoryProfile,
  getMemorySettings,
  getMemoryState,
  listMemoryEntries,
  saveMemorySnapshot,
} from "./store";
import {
  LONG_TERM_KINDS,
  MEMORY_COMPACT_EARLY_RATIO,
  MEMORY_LONG_TERM_MAX,
  MEMORY_MAX_CHARS,
  MEMORY_RECENT_MAX,
  type ConsolidationSummary,
} from "./types";

const COMPACT_TIMEOUT_MS = 120_000;

export interface CompactionDeps {
  model?: ModelConfig | null;
  now?: number;
  signal?: AbortSignal;
  callModel?: typeof callMemoryModel;
}

/** 是否进入新的自然月（lastCompactedAt 与 now 不同月 = 该精简了）。 */
export function isNewMonth(lastCompactedAt: number | undefined, now: number): boolean {
  if (lastCompactedAt === undefined) return true;
  const a = new Date(lastCompactedAt);
  const b = new Date(now);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth();
}

/** 容量是否超过提前触发线（条数按两类各自的 90%，正文字数按总量 90%）。 */
export function isNearCapacity(
  entries: Array<{ kind: string; title: string; body: string; validTo?: number }>,
): boolean {
  const live = entries.filter((e) => e.validTo === undefined);
  const longTerm = live.filter((e) => (LONG_TERM_KINDS as readonly string[]).includes(e.kind)).length;
  const recent = live.length - longTerm;
  const chars = live.reduce((n, e) => n + e.title.length + e.body.length, 0);
  return (
    chars >= MEMORY_MAX_CHARS * MEMORY_COMPACT_EARLY_RATIO ||
    longTerm >= MEMORY_LONG_TERM_MAX * MEMORY_COMPACT_EARLY_RATIO ||
    recent >= MEMORY_RECENT_MAX * MEMORY_COMPACT_EARLY_RATIO
  );
}

export function shouldCompact(
  lastCompactedAt: number | undefined,
  entries: Array<{ kind: string; title: string; body: string; validTo?: number }>,
  now: number,
): boolean {
  return isNewMonth(lastCompactedAt, now) || isNearCapacity(entries);
}

/** 下一次例行精简的日期（下个自然月 1 号）。容量到 90% 会提前触发。 */
export function nextCompactionAt(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/**
 * 跑一次月度精简。返回摘要；不需要 / 不能跑时返回 null。
 * 快照在模型返回之后、写入之前保存 —— 只有真的要改库时才留撤销点。
 */
export async function runMonthlyCompaction(
  deps: CompactionDeps = {},
): Promise<ConsolidationSummary | null> {
  const now = deps.now ?? Date.now();
  const settings = await getMemorySettings();
  if (!settings.enabled) return null;

  const model = deps.model !== undefined ? deps.model : await resolveMemoryModel();
  if (!model) return null;

  const state = await getMemoryState();
  let entries = await listMemoryEntries();
  if (entries.length === 0) return null;
  if (!shouldCompact(state.lastCompactedAt, entries, now)) return null;

  // 先清掉 30 天没用过的近期片段（不调模型的那一半工作）。
  await expireStaleRecent(now).catch(() => {});
  entries = await listMemoryEntries();
  if (entries.length === 0) {
    await applyMemoryOps([], {
      origin: "consolidated",
      now,
      statePatch: { lastCompactedAt: now },
    });
    return null;
  }

  const callModel = deps.callModel ?? callMemoryModel;
  const profile = await getMemoryProfile();
  const raw = await callModel(
    model,
    [
      { role: "system", content: MEMORY_COMPACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildCompactionUserPrompt({ profileText: profile.text, entries }),
      },
    ],
    { signal: deps.signal, timeoutMs: COMPACT_TIMEOUT_MS },
  );
  if (!raw) return null;

  const ops = parseMemoryOps(raw);
  // 模型没给出任何操作 → 记下精简时间，不留快照。
  if (ops.length === 0) {
    await applyMemoryOps([], {
      origin: "consolidated",
      now,
      statePatch: { lastCompactedAt: now },
    });
    return null;
  }

  await saveMemorySnapshot(now);
  const plan = await applyMemoryOps(ops, {
    origin: "consolidated",
    now,
    statePatch: (p) => ({ lastCompactedAt: now, lastSummary: p.summary }),
  });
  return plan.summary;
}
