// src/lib/monitors/types.ts
//
// Pie 2.0 §4.1 — page monitor records. One IDB store `monitors`, keyPath "id".

export interface MonitorTarget {
  /** 首选定定位：CSS selector。 */
  selector: string;
  /** selector 所属 frame 的 URL（跨 frame 定位时记录，用于重新定位参考）。 */
  frameUrl?: string;
  /** 文本锚点：selector 失效时按这段文字在页面里找回目标。 */
  anchorText?: string;
  /** 创建时取到的值，用于试跑核对与 anchorText 缺失时兜底匹配。 */
  sample: string;
}

export type MonitorIntervalMinutes = 15 | 60 | 360 | 1440;

export type MonitorCondition =
  /** 任何变化（与上次取到的值不同）。 */
  | { kind: "changed" }
  /** 数值类：低于 / 高于阈值。 */
  | { kind: "number"; op: "lt" | "gt"; value: number }
  /** 文本类：出现某段文字。 */
  | { kind: "contains"; text: string }
  /** 列表类：出现上次没有的条目。 */
  | { kind: "list_added" };

export type MonitorStatus = "active" | "paused" | "expired";

export type MonitorPausedReason = "login" | "not_found" | "blocked" | "network" | "user";

export interface MonitorHistoryEntry {
  at: number;
  value: string;
  met: boolean;
}

export interface MonitorRecord {
  id: string; // "mon_<uuid>"
  title: string;
  url: string;
  target: MonitorTarget;
  condition: MonitorCondition;
  intervalMinutes: MonitorIntervalMinutes;
  /** 默认创建 + 30 天。 */
  expiresAt: number;
  /** 首次检查时自动判定，之后可能升级 direct → tab。 */
  fetchMode: "direct" | "tab";
  status: MonitorStatus;
  pausedReason?: MonitorPausedReason;
  lastValue?: string;
  lastCheckedAt?: number;
  /** 边沿触发用：上一次判定的结果。 */
  lastMet: boolean;
  /** 连续失败次数；达到阈值自动暂停。 */
  consecutiveFailures: number;
  /** 变化记录，最多 HISTORY_LIMIT 条（新的在后）。 */
  history: MonitorHistoryEntry[];
  createdAt: number;
  /** 下次检查时间（仅展示用；真正调度在 chrome.alarms）。 */
  nextCheckAt?: number;
  /**
   * §4.3.4 — 同一条监控 1 小时内最多一条通知。
   * ponytail: 存一个时间戳比从 history 反推便宜也准确。
   */
  lastNotifiedAt?: number;
  /**
   * §6 — tab 兜底检查时打开的后台标签页 id。检查结束即关闭；SW 中途被杀时
   * 启动 reconcile 按这个字段补关（复用定时任务 ownedTabId 的思路）。
   */
  activeTabId?: number;
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 最多 30 条监控。 */
export const MAX_MONITORS = 30;

/** 最短间隔 15 分钟（§4.3 上限；也决定它不适合秒级盯盘）。 */
export const MIN_MONITOR_INTERVAL_MINUTES = 15;

/** 默认过期时间：创建 + 30 天。 */
export const MONITOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 连续失败多少次自动暂停。 */
export const MONITOR_FAILURE_PAUSE_THRESHOLD = 3;

/** 单条监控的变化记录上限。 */
export const MONITOR_HISTORY_LIMIT = 200;

/** 同一条监控的通知最小间隔（1 小时）。 */
export const MONITOR_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

/** 全局最多 6 个监控检查并发（§6，与定时任务各自计）。 */
export const MAX_CONCURRENT_MONITOR_CHECKS = 6;

/**
 * 检查间隔抖动 ±10%（§4.3.6 克制）。抽成函数便于测试确定性——调用方传 random。
 */
export function jitterMs(baseMs: number, random: () => number): number {
  const factor = 0.9 + random() * 0.2; // 0.9 .. 1.1
  return Math.round(baseMs * factor);
}

export function newMonitorId(): string {
  return "mon_" + crypto.randomUUID();
}
