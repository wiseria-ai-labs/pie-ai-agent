// src/lib/monitors/notify.ts
//
// §4.5 — system notifications for page monitors.
//
//   title   = the result ("Sony WH-1000XM6 降到 ¥1,999")
//   message = the evidence and the source ("低于你设的 ¥2,000 · shop.example.com")
//   buttons = [打开页面, 停止监控]
//
// Clicking opens the PAGE, not the side panel: Chrome forbids opening a side
// panel without a user gesture, and a tab always opens. The activity feed keeps
// the in-app record (§6), so the click never has to carry state.
//
// Notifications are English — same as the existing schedule notifications
// (schedules/notify.ts). Panel copy is localized; SW notification copy is not.
// ponytail: one language for SW notifications until the whole SW layer is
// localized; the feed itself (where users actually look) is fully localized.

import { getMonitor } from "./store";
import { pauseMonitorOp } from "./ops";

export const MONITOR_HIT_NOTIF_PREFIX = "monitor-hit:";
export const MONITOR_PAUSED_NOTIF_PREFIX = "monitor-paused:";

export const MONITOR_NOTIF_BUTTONS = [
  { title: "Open page" },
  { title: "Stop monitoring" },
] as const;

function iconUrl(): string {
  try {
    return chrome.runtime.getURL("icons/icon-48.png");
  } catch {
    return "";
  }
}

async function createNotification(
  id: string,
  title: string,
  message: string,
  buttons?: Array<{ title: string }>,
): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      chrome.notifications.create(
        id,
        {
          type: "basic",
          iconUrl: iconUrl(),
          title: title.slice(0, 120),
          message: message.slice(0, 200),
          ...(buttons ? { buttons } : {}),
        },
        () => resolve(),
      );
    });
  } catch {
    // Notifications API unavailable / permission missing — non-fatal.
  }
}

/** §4.5 triggered notification. */
export async function notifyMonitorHit(opts: {
  monitorId: string;
  title: string;
  body: string;
}): Promise<void> {
  await createNotification(
    `${MONITOR_HIT_NOTIF_PREFIX}${opts.monitorId}`,
    opts.title,
    opts.body,
    [...MONITOR_NOTIF_BUTTONS],
  );
}

/** §4.3.5 — one notification when a monitor auto-pauses after repeated failures. */
export async function notifyMonitorPaused(opts: {
  monitorId: string;
  title: string;
  body: string;
}): Promise<void> {
  await createNotification(
    `${MONITOR_PAUSED_NOTIF_PREFIX}${opts.monitorId}`,
    opts.title,
    opts.body,
  );
}

async function openMonitorPage(monitorId: string): Promise<void> {
  const rec = await getMonitor(monitorId);
  if (!rec) return;
  try {
    await chrome.tabs.create({ url: rec.url, active: true });
  } catch {
    /* tab creation failed — nothing else to do */
  }
}

/** Parse a monitor notification id back to (kind, monitorId). */
export function parseMonitorNotificationId(
  notificationId: string,
): { kind: "hit" | "paused"; monitorId: string } | null {
  if (notificationId.startsWith(MONITOR_HIT_NOTIF_PREFIX)) {
    return { kind: "hit", monitorId: notificationId.slice(MONITOR_HIT_NOTIF_PREFIX.length) };
  }
  if (notificationId.startsWith(MONITOR_PAUSED_NOTIF_PREFIX)) {
    return { kind: "paused", monitorId: notificationId.slice(MONITOR_PAUSED_NOTIF_PREFIX.length) };
  }
  return null;
}

/** Notification body click → open the monitored page. Never throws. */
export async function handleMonitorNotificationClick(notificationId: string): Promise<void> {
  try {
    const parsed = parseMonitorNotificationId(notificationId);
    if (!parsed) return;
    await openMonitorPage(parsed.monitorId);
  } catch {
    /* listener must never crash the SW */
  }
}

/**
 * Notification button click. 0 = open page, 1 = stop monitoring (pause, kept
 * resumable from the monitor list — "停止" here means stop the noise now, the
 * user can delete it from the panel).
 */
export async function handleMonitorNotificationButton(
  notificationId: string,
  buttonIndex: number,
): Promise<void> {
  try {
    const parsed = parseMonitorNotificationId(notificationId);
    if (!parsed) return;
    if (buttonIndex === 0) {
      await openMonitorPage(parsed.monitorId);
      return;
    }
    if (buttonIndex === 1) {
      await pauseMonitorOp(parsed.monitorId, "user");
    }
  } catch {
    /* listener must never crash the SW */
  }
}
