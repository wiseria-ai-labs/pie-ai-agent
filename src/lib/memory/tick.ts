// src/lib/memory/tick.ts
//
// 每小时一次的 `memory:tick` 心跳：
//   - 没有前台任务在跑（`isBusy()`）且处于活跃订阅（`cloud_active`）时，
//     推送新增会话/历史摘要至云端，并从云端拉取最新记忆镜像。

import { getMemoryAccessState } from "./access";
import { flushMemoryDigests } from "./digest-sync";
import { syncMemoryFromCloud } from "./sync";

export const MEMORY_ALARM = "memory:tick";
const PERIOD_MINUTES = 60;

export interface MemoryTickDeps {
  /** 有前台 agent 任务 / 定时任务在跑 → 本次心跳跳过。 */
  isBusy?: () => boolean;
  now?: () => number;
}

/** 建心跳 alarm（幂等：已存在就不动）。SW 每次启动都调一次。 */
export async function ensureMemoryAlarm(): Promise<void> {
  if (!chrome.alarms) return;
  const existing = await chrome.alarms.get(MEMORY_ALARM);
  if (existing) return;
  chrome.alarms.create(MEMORY_ALARM, {
    periodInMinutes: PERIOD_MINUTES,
    delayInMinutes: 1,
  });
}

/** SW onAlarm 入口。名字不匹配立即返回；任何失败只 log，不抛。 */
export async function handleMemoryAlarm(name: string, deps: MemoryTickDeps = {}): Promise<void> {
  if (name !== MEMORY_ALARM) return;
  if (deps.isBusy?.()) return;
  const now = deps.now?.() ?? Date.now();

  const access = await getMemoryAccessState();
  if (access.mode !== "cloud_active") return;

  try {
    await syncMemoryFromCloud({ force: true, now });
  } catch (e) {
    console.warn("[memory] cloud mirror pull failed:", e);
  }
  try {
    await flushMemoryDigests({ now });
  } catch (e) {
    console.warn("[memory] cloud digest push failed:", e);
  }
}
