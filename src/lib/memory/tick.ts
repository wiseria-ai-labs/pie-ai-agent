// src/lib/memory/tick.ts
//
// 每小时一次的 `memory:tick` 心跳（spec §5.4「调度：用水位线，不靠准点」）。
//
// 满足条件才执行整理：
//   1. 距上次整理 ≥ 20 小时（由 runDailyConsolidation 自己判断）；
//   2. 没有前台任务在跑（`isBusy()`，记忆整理独占一个槽位，只在空闲时跑）；
//   3. 记忆模型可用（runDailyConsolidation 内部判断）。
//
// 月度精简跟同一次心跳走（isNewMonth / 容量 90%）。

import { getMemoryAccessState } from "./access";
import { runMonthlyCompaction } from "./compact";
import { runDailyConsolidation } from "./consolidate";
import { flushMemoryDigests } from "./digest-sync";
import { syncMemoryFromCloud } from "./sync";

export const MEMORY_ALARM = "memory:tick";
const PERIOD_MINUTES = 60;

export interface MemoryTickDeps {
  /** 有前台 agent 任务 / 定时任务在跑 → 本次心跳跳过。 */
  isBusy?: () => boolean;
  now?: () => number;
  runConsolidation?: typeof runDailyConsolidation;
  runCompaction?: typeof runMonthlyCompaction;
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

  if (!deps.runConsolidation && !deps.runCompaction) {
    const access = await getMemoryAccessState();
    if (access.mode === "cloud_active") {
      try {
        await flushMemoryDigests({ now });
      } catch (e) {
        console.warn("[memory] cloud digest push failed:", e);
      }
      try {
        await syncMemoryFromCloud({ force: true, now });
      } catch (e) {
        console.warn("[memory] cloud mirror pull failed:", e);
      }
      return;
    }
    if (access.mode !== "local_dev") return;
  }

  const consolidate = deps.runConsolidation ?? runDailyConsolidation;
  const compact = deps.runCompaction ?? runMonthlyCompaction;
  try {
    await consolidate({ now });
  } catch (e) {
    console.warn("[memory] daily consolidation failed:", e);
  }
  try {
    await compact({ now });
  } catch (e) {
    console.warn("[memory] monthly compaction failed:", e);
  }
}
