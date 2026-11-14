// src/lib/memory/selector.ts
//
// 挑选层（spec §5.5）：一个快速模型读「画像 + 索引 + 任务文本 + 当前页标题/网址」
// （**不含页面正文**），只回 `{"ids":[...]}`，最多 8 条。
//
// 预算：软超时 2.5s / 硬超时 4s（callMemoryModel 的 timeoutMs）；关 thinking；
// 索引 > 500 条时先做廉价规则预筛。超时 / 失败 / 空结果都返回空数组 —— 调用方
// 静默跳过，只保留画像。这是正常路径，不是异常分支。
//
// 与第一轮并行：`startMemoryPrefetch()` 是唯一入口（浮层预取将来也复用它）。

import type { ModelConfig } from "@/lib/model-router";
import { callMemoryModel, resolveMemoryModel } from "./model";
import {
  buildMemoryIndexLines,
  buildMemorySelectorUserPrompt,
  MEMORY_SELECTOR_SYSTEM_PROMPT,
} from "./prompt";
import { listMemoryEntries, getMemoryProfile, getMemorySettings, getMemoryState, recordMemoryUsage, setMemoryState } from "./store";
import {
  LONG_TERM_KINDS,
  MEMORY_INDEX_MAX,
  MEMORY_PICK_DAILY_CAP,
  MEMORY_PICK_HARD_TIMEOUT_MS,
  MEMORY_PICK_MAX,
  type MemoryEntry,
} from "./types";

export interface MemoryPickInput {
  task: string;
  pageTitle?: string;
  pageUrl?: string;
  signal?: AbortSignal;
  /** 测试注入。 */
  now?: number;
  model?: ModelConfig | null;
  callModel?: typeof callMemoryModel;
}

export interface MemoryPrefetch {
  startedAt: number;
  /** 已挑选的条目；超时 / 失败 / 不相关 → 空数组。 */
  promise: Promise<MemoryEntry[]>;
  abort: () => void;
}

function todayKey(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "please", "帮我", "一下", "我的", "这个", "那个", "什么", "怎么",
  "可以", "需要", "现在", "然后", "还有", "一个", "我们", "你们", "他们",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 40);
}

/**
 * 索引超过 MEMORY_INDEX_MAX 时的廉价预筛（不是 embedding）：长期条目全留，
 * 近期条目只留最近 30 天用过的或与任务有词面重合的，再按分数截断。
 */
export function prefilterIndex(
  entries: MemoryEntry[],
  task: string,
  now: number,
): MemoryEntry[] {
  if (entries.length <= MEMORY_INDEX_MAX) return entries;
  const words = tokens(task);
  const hits = (e: MemoryEntry) => {
    const hay = `${e.title} ${e.body} ${e.tags.join(" ")}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  };
  const recentCut = now - 30 * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => {
    if (LONG_TERM_KINDS.includes(e.kind)) return true;
    return (e.lastUsedAt ?? 0) >= recentCut || hits(e);
  });
  if (kept.length <= MEMORY_INDEX_MAX) return kept;
  const score = (e: MemoryEntry) => (hits(e) ? 1_000 : 0) + e.useCount * 10 + e.updatedAt / 1e12;
  return kept.sort((a, b) => score(b) - score(a)).slice(0, MEMORY_INDEX_MAX);
}

/** 从模型输出里宽松地抽 id（不依赖 JSON mode）。 */
export function parseSelectedIds(raw: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/\bm_[0-9a-zA-Z-]+/g)) {
    const id = m[0]!;
    if (!known.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MEMORY_PICK_MAX) break;
  }
  return out;
}

/**
 * 跑一次挑选。任何前置条件不满足都直接返回 []（记忆没开 / 没条目 / 没模型 /
 * 当日超限）。调用方不需要区分「没选到」和「没跑」。
 */
export async function pickMemory(input: MemoryPickInput): Promise<MemoryEntry[]> {
  const now = input.now ?? Date.now();
  const settings = await getMemorySettings();
  if (!settings.enabled) return [];

  const model = input.model !== undefined ? input.model : await resolveMemoryModel();
  if (!model) return [];

  const entries = (await listMemoryEntries()).filter((e) => e.validTo === undefined);
  if (entries.length === 0) return [];

  // 每日挑选调用上限（网关侧同样限流）。
  const state = await getMemoryState();
  const day = todayKey(now);
  const used = state.pick?.date === day ? state.pick.count : 0;
  if (used >= MEMORY_PICK_DAILY_CAP) return [];
  await setMemoryState({ pick: { date: day, count: used + 1 } });

  const candidates = prefilterIndex(entries, input.task, now);
  const profile = await getMemoryProfile();
  const userPrompt = buildMemorySelectorUserPrompt({
    task: input.task,
    pageTitle: input.pageTitle,
    pageUrl: input.pageUrl,
    profileText: profile.text,
    indexLines: buildMemoryIndexLines(candidates),
  });

  const callModel = input.callModel ?? callMemoryModel;
  const raw = await callModel(
    model,
    [
      { role: "system", content: MEMORY_SELECTOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { signal: input.signal, timeoutMs: MEMORY_PICK_HARD_TIMEOUT_MS },
  );
  if (!raw) return [];

  const ids = parseSelectedIds(raw, new Set(candidates.map((e) => e.id)));
  if (ids.length === 0) return [];
  const picked = ids
    .map((id) => entries.find((e) => e.id === id))
    .filter((e): e is MemoryEntry => !!e && e.validTo === undefined);
  if (picked.length > 0) {
    await recordMemoryUsage(picked.map((e) => e.id), now).catch(() => {});
  }
  return picked;
}

/**
 * 预取入口 —— 与 agent 第一轮并行跑。浮层线接入时直接调用本函数拿
 * `promise`，不必等 loop。
 */
export function startMemoryPrefetch(input: MemoryPickInput): MemoryPrefetch {
  const ctrl = new AbortController();
  const startedAt = input.now ?? Date.now();
  const onOuterAbort = () => ctrl.abort();
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const promise = pickMemory({ ...input, signal: ctrl.signal }).catch(() => []);
  return {
    startedAt,
    promise,
    abort: () => ctrl.abort(),
  };
}

/** `recall_memory` 工具：中途按需查一次，内部复用挑选流程。 */
export async function recallMemory(
  query: string,
  opts: { signal?: AbortSignal; now?: number } = {},
): Promise<MemoryEntry[]> {
  return pickMemory({ task: query, signal: opts.signal, now: opts.now });
}
