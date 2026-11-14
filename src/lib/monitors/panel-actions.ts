// src/lib/monitors/panel-actions.ts
//
// panel → SW write channel for monitor mutations (same shape as
// schedules/panel-actions.ts). The panel READS monitors straight from IDB and
// routes every MUTATION through the SW so it runs with the injected bound
// checkMonitor (alarm re-arming / immediate checks need the real deps).

import { swPort } from "@/lib/sw-connection/manager";
import type { MonitorCondition, MonitorIntervalMinutes } from "./types";

export const MONITOR_ACTION_MESSAGE = "monitor-action" as const;

export type MonitorAction =
  | {
      action: "update";
      payload: {
        id: string;
        title?: string;
        condition?: MonitorCondition;
        intervalMinutes?: MonitorIntervalMinutes;
      };
    }
  | { action: "delete"; payload: { id: string } }
  | { action: "pause"; payload: { id: string } }
  | { action: "resume"; payload: { id: string } }
  | { action: "check-now"; payload: { id: string } };

export interface MonitorActionMessage {
  type: typeof MONITOR_ACTION_MESSAGE;
  action: MonitorAction["action"];
  payload: MonitorAction["payload"];
}

export type MonitorActionResponse = { ok: true; id?: string } | { ok: false; error: string };

async function send(
  action: MonitorAction["action"],
  payload: MonitorAction["payload"],
): Promise<MonitorActionResponse> {
  return swPort.request<MonitorActionResponse>({
    type: MONITOR_ACTION_MESSAGE,
    action,
    payload,
  });
}

export function updateMonitor(payload: Extract<MonitorAction, { action: "update" }>["payload"]) {
  return send("update", payload);
}
export function deleteMonitor(id: string) {
  return send("delete", { id });
}
export function pauseMonitor(id: string) {
  return send("pause", { id });
}
export function resumeMonitor(id: string) {
  return send("resume", { id });
}
export function checkMonitorNow(id: string) {
  return send("check-now", { id });
}
