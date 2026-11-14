// src/lib/monitors/action-handler.ts
//
// SW-side handler for the panel monitor write channel. Routes onto the shared
// ops core; always resolves { ok, error? } (never rejects). Same shape as
// schedules/action-handler.ts.

import {
  checkMonitorNowOp,
  deleteMonitorOp,
  pauseMonitorOp,
  resumeMonitorOp,
  updateMonitorOp,
  type OpResult,
} from "./ops";
import type { MonitorAction } from "./panel-actions";

export async function handleMonitorAction(msg: {
  action: MonitorAction["action"];
  payload: MonitorAction["payload"];
}): Promise<OpResult> {
  try {
    switch (msg.action) {
      case "update": {
        const p = msg.payload as Extract<MonitorAction, { action: "update" }>["payload"];
        return await updateMonitorOp(p);
      }
      case "delete": {
        const p = msg.payload as Extract<MonitorAction, { action: "delete" }>["payload"];
        return await deleteMonitorOp(p?.id);
      }
      case "pause": {
        const p = msg.payload as Extract<MonitorAction, { action: "pause" }>["payload"];
        return await pauseMonitorOp(p?.id, "user");
      }
      case "resume": {
        const p = msg.payload as Extract<MonitorAction, { action: "resume" }>["payload"];
        return await resumeMonitorOp(p?.id);
      }
      case "check-now": {
        const p = msg.payload as Extract<MonitorAction, { action: "check-now" }>["payload"];
        return await checkMonitorNowOp(p?.id);
      }
      default:
        return { ok: false, error: `unknown monitor action: ${String(msg.action)}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
