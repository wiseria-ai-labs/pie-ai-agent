// src/lib/monitors/scheduler.ts
//
// chrome.alarms wrapper for page monitors (§4.3 / §6). Alarm name =
// "monitor:<id>" — the same shape as "schedule:<id>", so the SW's single
// onAlarm listener can route by prefix and a future "memory:tick" coexists.
//
// Reuses the schedules scheduler's policies verbatim:
//   - overdue alarms fire once (no interval catch-up, matching "Chrome 关闭时
//     不检查，下次启动补查一次")
//   - the concurrency cap load-sheds by re-arming shortly instead of skipping
//   - ±10% jitter on every re-arm so a batch of same-interval monitors never
//     march in lockstep

import { listMonitors, patchMonitor } from "./store";
import {
  MAX_CONCURRENT_MONITOR_CHECKS,
  jitterMs,
  type MonitorRecord,
} from "./types";

export const MONITOR_ALARM_PREFIX = "monitor:";

/** Re-arm delay when the check cap is full (load-shed, not a skip). */
export const MONITOR_DEFER_MS = 60_000;

export interface MonitorSchedulerDeps {
  /** Bound checkMonitor(monitorId). */
  checkMonitor: (monitorId: string) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Live monitor checks in flight (SW's runningMonitorIds.size). Absent = no cap. */
  runningCount?: () => number;
}

function alarmName(id: string): string {
  return MONITOR_ALARM_PREFIX + id;
}

export function idFromMonitorAlarm(name: string): string | null {
  if (!name.startsWith(MONITOR_ALARM_PREFIX)) return null;
  const id = name.slice(MONITOR_ALARM_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** nextCheckAt for a monitor whose last check just happened (or is being armed). */
export function nextCheckAt(
  rec: MonitorRecord,
  now: number,
  random: () => number = Math.random,
): number {
  return now + jitterMs(rec.intervalMinutes * 60_000, random);
}

/** Create/replace the alarm and persist the visible next-check time. */
export async function armMonitor(
  rec: MonitorRecord,
  deps: Pick<MonitorSchedulerDeps, "now" | "random"> = {},
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const at = nextCheckAt(rec, now, deps.random);
  chrome.alarms.create(alarmName(rec.id), { when: at });
  await patchMonitor(rec.id, { nextCheckAt: at });
}

/** Just (re)create the alarm at a timestamp the caller computed. */
export async function setNextCheckAlarm(id: string, at: number): Promise<void> {
  chrome.alarms.create(alarmName(id), { when: at });
}

export async function disarmMonitor(id: string): Promise<void> {
  await chrome.alarms.clear(alarmName(id));
}

function atCap(deps: MonitorSchedulerDeps): boolean {
  const running = deps.runningCount?.();
  return running != null && running >= MAX_CONCURRENT_MONITOR_CHECKS;
}

function dispatch(deps: MonitorSchedulerDeps, id: string): void {
  void Promise.resolve(deps.checkMonitor(id)).catch((e) => {
    console.warn(`[monitor-scheduler] checkMonitor(${id}) rejected:`, e);
  });
}

/**
 * Handle a fired alarm: dispatch the check (fire-and-forget — checks are short
 * and never block the alarm pipeline) and leave re-arming to the check itself
 * (it knows whether the monitor ended up paused/expired).
 */
export async function handleMonitorAlarm(
  name: string,
  deps: MonitorSchedulerDeps,
): Promise<void> {
  const id = idFromMonitorAlarm(name);
  if (!id) return;

  const now = deps.now?.() ?? Date.now();
  if (atCap(deps)) {
    chrome.alarms.create(alarmName(id), { when: now + MONITOR_DEFER_MS });
    return;
  }
  dispatch(deps, id);
}

/**
 * True when both URLs share an origin. Tab ids are NOT stable across browser
 * sessions (Chrome restarts numbering), so a persisted `activeTabId` can point
 * at an unrelated user tab after a restart — reconcile must verify before it
 * closes anything.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Startup reconcile (§6): close orphaned hidden tabs, expire records past
 * `expiresAt`, then re-create lost alarms. A missing alarm whose nextCheckAt is
 * overdue fires once — never a burst of catch-up checks.
 */
export async function reconcileMonitors(
  now: number,
  deps: MonitorSchedulerDeps,
): Promise<void> {
  const all = await listMonitors();
  for (const rec of all) {
    // Close a hidden tab left behind by an SW kill (owned-tab cleanup, §4.3.2).
    // Only when the tab is still ours — see sameOrigin above.
    if (rec.activeTabId != null) {
      try {
        const tab = await chrome.tabs.get(rec.activeTabId);
        if (tab.url && sameOrigin(tab.url, rec.url)) {
          await chrome.tabs.remove(rec.activeTabId);
        }
      } catch {
        /* tab already gone */
      }
      await patchMonitor(rec.id, { activeTabId: undefined });
    }

    if (rec.status === "active" && rec.expiresAt <= now) {
      await disarmMonitor(rec.id);
      await patchMonitor(rec.id, { status: "expired", nextCheckAt: undefined });
      continue;
    }
    if (rec.status !== "active") {
      await disarmMonitor(rec.id);
      continue;
    }
    // A monitor that accumulated failures while the SW was down pauses itself
    // on the next check (check.ts owns that transition) — reconcile only
    // restores alarms.
    const existing = await chrome.alarms.get(alarmName(rec.id));
    if (existing) continue;

    const when = rec.nextCheckAt;
    if (when == null || when <= now) {
      if (atCap(deps)) {
        chrome.alarms.create(alarmName(rec.id), { when: now + MONITOR_DEFER_MS });
      } else {
        dispatch(deps, rec.id);
      }
    } else {
      chrome.alarms.create(alarmName(rec.id), { when });
    }
  }
}
