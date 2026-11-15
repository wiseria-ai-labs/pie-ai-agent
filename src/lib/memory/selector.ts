// src/lib/memory/selector.ts
//
// 挑选层（spec §5.5）：请求云端 `POST /memory/pick` 获取与当前任务相关的条目。
// 超时 / 失败 / 非活跃订阅 / 空结果都返回空数组 —— 调用方静默跳过，只保留画像。
//
// 与第一轮并行：`startMemoryPrefetch()` 是唯一入口。

import { getMemoryAccessState } from "./access";
import { pickCloudMemory } from "./cloud";
import { getMemorySettings, getMemoryState } from "./store";
import { syncMemoryFromCloud } from "./sync";
import {
  MEMORY_PICK_HARD_TIMEOUT_MS,
  type MemoryEntry,
} from "./types";

export interface MemoryPickInput {
  task: string;
  pageTitle?: string;
  pageUrl?: string;
  signal?: AbortSignal;
  /** 测试注入。 */
  now?: number;
  fetchFn?: typeof fetch;
}

export interface MemoryPrefetch {
  startedAt: number;
  /** 已挑选的条目；超时 / 失败 / 不相关 → 空数组。 */
  promise: Promise<MemoryEntry[]>;
  abort: () => void;
}

/**
 * 跑一次云端挑选。任何前置条件不满足（记忆没开 / 未订阅）都直接返回 []。
 */
export async function pickMemory(input: MemoryPickInput): Promise<MemoryEntry[]> {
  const settings = await getMemorySettings();
  if (!settings.enabled) return [];

  const access = await getMemoryAccessState();
  if (access.mode !== "cloud_active") return [];

  const res = await pickCloudMemory(
    access.apiKey,
    {
      task: input.task,
      ...(input.pageTitle !== undefined ? { pageTitle: input.pageTitle } : {}),
      ...(input.pageUrl !== undefined ? { pageUrl: input.pageUrl } : {}),
    },
    {
      signal: input.signal,
      timeoutMs: MEMORY_PICK_HARD_TIMEOUT_MS,
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    },
  );
  const localRev = (await getMemoryState()).cloudRevision ?? 0;
  if (res.revision > localRev) {
    void syncMemoryFromCloud({ deps: input.fetchFn ? { fetchFn: input.fetchFn } : undefined }).catch(
      () => {},
    );
  }
  return res.entries;
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
