// src/lib/agent/tools/monitor-meta.ts
//
// Pie 2.0 §4.2 / §8 — page-monitor meta tools.
//
//   propose_monitor — read class. Produces the monitor card (F9). Before the
//       card appears it TRIALS the URL the way a real check would (no user tab),
//       which both validates that the value is reproducible from the URL alone
//       and fixes fetchMode. On a failed trial the card still appears but only
//       explains why and points at the scheduled-task fallback (§4.4).
//   list_monitors   — read class.
//   update_monitor / delete_monitor — write class.
//
// Headless runs exclude propose/update/delete (run.ts HEADLESS_EXCLUDE_TOOL_*):
// a monitor must never be able to spawn or rewire monitors on its own, and there
// is no panel to answer the card in a headless run.

import type { ActionResult } from "../../dom-actions/types";
import type { Tool } from "../types";
import type { ToolHandlerContext } from "../types";
import { listMonitors } from "../../monitors/store";
import {
  createMonitorOp,
  trialMonitor,
  updateMonitorOp,
  deleteMonitorOp,
  validateCondition,
  validateInterval,
  validateUrl,
  VALID_INTERVALS,
  type TrialResult,
} from "../../monitors/ops";
import type {
  MonitorCondition,
  MonitorIntervalMinutes,
  MonitorTarget,
} from "../../monitors/types";
import { escapeUntrustedWrappers } from "../../agent/untrusted-wrappers";

// ── 挂起式监控卡（F9）— 公共类型 ──────────────────────────────────────────────

export interface MonitorDraftPayload {
  title: string;
  url: string;
  condition: MonitorCondition;
  /** 人类可读的条件摘要（卡片上一行字）。 */
  conditionSummary: string;
  /** 试跑结果：决定卡片是否提供「开始监控」。 */
  trial: TrialResult;
  intervalMinutes: MonitorIntervalMinutes;
}

export type MonitorDraftResponse =
  | { action: "start"; intervalMinutes: MonitorIntervalMinutes }
  | { action: "cancel" };

// ── Helpers ──────────────────────────────────────────────────────────────────

function err(reason: string): ActionResult {
  return { success: false, error: reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function summarizeCondition(c: MonitorCondition): string {
  switch (c.kind) {
    case "changed":
      return "any change";
    case "number":
      return `${c.op === "lt" ? "below" : "above"} ${c.value}`;
    case "contains":
      return `contains "${c.text}"`;
    case "list_added":
      return "new list items";
  }
}

/** Wrap page-derived strings before they enter LLM context. */
function untrusted(tag: string, body: string): string {
  return `<${tag}>${escapeUntrustedWrappers(body)}</${tag}>`;
}

async function resolveUrl(raw: unknown, ctx: ToolHandlerContext): Promise<string | null> {
  if (isNonEmptyString(raw)) return raw;
  // Fall back to the tab the task is pinned to — the model may not know the URL.
  if (typeof ctx.tabId === "number" && ctx.tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(ctx.tabId);
      if (tab.url) return tab.url;
    } catch {
      return null;
    }
  }
  return null;
}

function parseCondition(raw: unknown): MonitorCondition | null {
  if (!raw || typeof raw !== "object") return null;
  if (validateCondition(raw) !== null) return null;
  return raw as MonitorCondition;
}

// ── Tool: propose_monitor ────────────────────────────────────────────────────

const proposeMonitorTool: Tool = {
  name: "propose_monitor",
  description:
    "Propose a page monitor: watch one element on a page and tell the user when a condition flips. Use when the user says things like 'tell me when the price drops below X', 'let me know if anything changes here', or 'notify me when new jobs appear'. This shows a card the user must approve before anything is created — it does not create the monitor itself. Parse the condition from what the user said; if you cannot tell, ask instead of guessing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["selector", "condition"],
    properties: {
      title: { type: "string", description: "Short human-readable label for this monitor." },
      url: {
        type: "string",
        description: "Page URL to watch. Defaults to the tab the task is pinned to.",
      },
      selector: {
        type: "string",
        description: "CSS selector of the element to watch (e.g. '.price', '#status', 'ul.jobs li').",
      },
      anchorText: {
        type: "string",
        description:
          "Text currently visible in the target element. Used to re-locate the element if the page structure changes.",
      },
      condition: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: ["changed", "number", "contains", "list_added"],
            description:
              "'changed' = any change; 'number' = numeric threshold; 'contains' = text appears; 'list_added' = a list gains items.",
          },
          op: { type: "string", enum: ["lt", "gt"], description: "For kind=number: below / above." },
          value: { type: "number", description: "For kind=number: the threshold." },
          text: { type: "string", description: "For kind=contains: the text to look for." },
        },
      },
      intervalMinutes: {
        type: "number",
        enum: [...VALID_INTERVALS],
        description: "Check frequency in minutes (15 / 60 / 360 / 1440). Defaults to 60.",
      },
    },
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

    const url = await resolveUrl(a.url, ctx);
    if (!url) return err("url is required (could not resolve the current tab's URL)");
    const urlErr = validateUrl(url);
    if (urlErr) return err(urlErr);

    if (!isNonEmptyString(a.selector)) return err("selector is required");
    const condition = parseCondition(a.condition);
    if (!condition) return err(`invalid condition: ${JSON.stringify(a.condition)}`);

    const intervalMinutes = (a.intervalMinutes ?? 60) as MonitorIntervalMinutes;
    const intErr = validateInterval(intervalMinutes);
    if (intErr) return err(intErr);

    const target: MonitorTarget = {
      selector: a.selector.trim(),
      sample: "",
      ...(isNonEmptyString(a.anchorText) ? { anchorText: a.anchorText.trim() } : {}),
    };

    // §4.2 — trial run BEFORE the card, without borrowing the user's tab.
    const trial = await trialMonitor(url, target);
    if (trial.ok) target.sample = trial.value;

    if (!ctx.requestMonitorDraft) {
      return err(
        "cannot show the monitor card here (no side panel attached). Monitors can only be created from a chat with the panel open.",
      );
    }

    let decision: MonitorDraftResponse;
    try {
      decision = await ctx.requestMonitorDraft({
        title: isNonEmptyString(a.title) ? a.title.trim() : new URL(url).hostname,
        url,
        condition,
        conditionSummary: summarizeCondition(condition),
        trial,
        intervalMinutes,
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : "monitor card was not answered");
    }

    if (decision.action === "cancel") {
      return {
        success: true,
        observation: "The user dismissed the monitor card. No monitor was created.",
      };
    }

    if (!trial.ok) {
      return err(
        "cannot start monitoring: the trial check could not reproduce the value from the URL alone.",
      );
    }

    const res = await createMonitorOp({
      title: isNonEmptyString(a.title) ? a.title.trim() : new URL(url).hostname,
      url,
      target,
      condition,
      intervalMinutes: decision.intervalMinutes,
      fetchMode: trial.fetchMode,
      initialValue: trial.value,
    });
    if (!res.ok) return err(res.error);

    return {
      success: true,
      observation:
        `monitor created: id=${res.id} ` +
        `condition=${summarizeCondition(condition)} every ${decision.intervalMinutes} min ` +
        `fetchMode=${trial.fetchMode}. It will notify the user when the condition flips. ` +
        `Current value: ${untrusted("untrusted_monitor_value", trial.value)}`,
    };
  },
};

// ── Tool: list_monitors ──────────────────────────────────────────────────────

const listMonitorsTool: Tool = {
  name: "list_monitors",
  description:
    "List the user's page monitors with id, title, url, condition, interval, status and current value. Use before propose_monitor to avoid duplicates, or when the user asks what is being watched.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  handler: async (): Promise<ActionResult> => {
    const all = await listMonitors();
    const summary = all.map((m) => ({
      id: m.id,
      title: m.title,
      url: m.url,
      condition: m.condition,
      intervalMinutes: m.intervalMinutes,
      status: m.status,
      pausedReason: m.pausedReason,
      lastValue: m.lastValue,
      lastCheckedAt: m.lastCheckedAt,
      nextCheckAt: m.nextCheckAt,
      lastMet: m.lastMet,
    }));
    // lastValue is third-party page text — the whole payload goes through the
    // untrusted wrapper so a malicious page cannot smuggle instructions in.
    return {
      success: true,
      observation: untrusted("untrusted_monitor_list", JSON.stringify(summary)),
    };
  },
};

// ── Tool: update_monitor ─────────────────────────────────────────────────────

const updateMonitorTool: Tool = {
  name: "update_monitor",
  description:
    "Update a page monitor's title, condition or check interval. Use list_monitors first to get the id.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "Monitor id (mon_*)." },
      title: { type: "string" },
      condition: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["changed", "number", "contains", "list_added"] },
          op: { type: "string", enum: ["lt", "gt"] },
          value: { type: "number" },
          text: { type: "string" },
        },
      },
      intervalMinutes: { type: "number", enum: [...VALID_INTERVALS] },
    },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (!isNonEmptyString(a.id)) return err("id is required");

    let condition: MonitorCondition | undefined;
    if (a.condition !== undefined) {
      const parsed = parseCondition(a.condition);
      if (!parsed) return err(`invalid condition: ${JSON.stringify(a.condition)}`);
      condition = parsed;
    }

    const res = await updateMonitorOp({
      id: a.id,
      ...(a.title !== undefined ? { title: a.title as string } : {}),
      ...(condition ? { condition } : {}),
      ...(a.intervalMinutes !== undefined
        ? { intervalMinutes: a.intervalMinutes as MonitorIntervalMinutes }
        : {}),
    });
    if (!res.ok) return err(res.error);
    return { success: true, observation: `monitor updated: id=${a.id}` };
  },
};

// ── Tool: delete_monitor ─────────────────────────────────────────────────────

const deleteMonitorTool: Tool = {
  name: "delete_monitor",
  description: "Permanently delete a page monitor and its change history.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", description: "Monitor id (mon_*)." } },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as { id?: unknown };
    if (!isNonEmptyString(a.id)) return err("id is required");
    const res = await deleteMonitorOp(a.id);
    if (!res.ok) return err(res.error);
    return { success: true, observation: `monitor deleted: ${a.id}` };
  },
};

// ── Public exports ───────────────────────────────────────────────────────────

export const MONITOR_META_TOOLS: Tool[] = [
  proposeMonitorTool,
  listMonitorsTool,
  updateMonitorTool,
  deleteMonitorTool,
];

export const MONITOR_META_TOOL_NAMES = [
  "propose_monitor",
  "list_monitors",
  "update_monitor",
  "delete_monitor",
] as const;

export type MonitorMetaToolName = (typeof MONITOR_META_TOOL_NAMES)[number];

export function isMonitorMetaToolName(name: string): name is MonitorMetaToolName {
  return (MONITOR_META_TOOL_NAMES as readonly string[]).includes(name);
}
