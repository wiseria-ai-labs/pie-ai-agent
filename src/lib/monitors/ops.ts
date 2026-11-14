// src/lib/monitors/ops.ts
//
// Shared monitor operations core — the single source of truth for create /
// update / delete / pause / resume / check-now, called by BOTH the agent tools
// (agent/tools/monitor-meta.ts) and the SW panel write channel
// (background/index.ts monitor-action). Same split as schedules/schedule-ops.ts.
//
// The bound checkMonitor is injected once at SW boot (setMonitorCheckDep) so
// "立即检查" and an immediate first check run with the real deps.

import { deleteInboxByRef } from "@/lib/inbox/store";
import { evaluateCondition } from "./condition";
import { extractDirect, extractViaTab, type CheckFailureReason } from "./extract";
import { armMonitor, disarmMonitor } from "./scheduler";
import {
  deleteMonitorRec,
  getMonitor,
  listMonitors,
  patchMonitor,
  putMonitor,
} from "./store";
import { isRestrictedScheduleUrl } from "@/lib/schedules/url-guard";
import {
  MAX_MONITORS,
  MIN_MONITOR_INTERVAL_MINUTES,
  MONITOR_TTL_MS,
  newMonitorId,
  type MonitorCondition,
  type MonitorIntervalMinutes,
  type MonitorPausedReason,
  type MonitorRecord,
  type MonitorTarget,
} from "./types";

export type OpResult = { ok: true; id?: string } | { ok: false; error: string };

const ok = (id?: string): OpResult => (id !== undefined ? { ok: true, id } : { ok: true });
const fail = (error: string): OpResult => ({ ok: false, error });

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export const VALID_INTERVALS: readonly number[] = [15, 60, 360, 1440];

// ── Injected check dispatcher ────────────────────────────────────────────────

let checkDep: (monitorId: string) => Promise<void> = async (id) => {
  console.warn(`[monitor-ops] checkDep not injected — check for ${id} dropped.`);
};

export function setMonitorCheckDep(fn: (monitorId: string) => Promise<void>): void {
  checkDep = fn;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `invalid url: ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `unsupported protocol: ${parsed.protocol}`;
  }
  if (isRestrictedScheduleUrl(url)) return `restricted page cannot be monitored: ${url}`;
  return null;
}

export function validateCondition(c: unknown): string | null {
  if (!c || typeof c !== "object") return "condition is required";
  const kind = (c as { kind?: unknown }).kind;
  switch (kind) {
    case "changed":
    case "list_added":
      return null;
    case "number": {
      const op = (c as { op?: unknown }).op;
      const value = (c as { value?: unknown }).value;
      if (op !== "lt" && op !== "gt") return 'number condition needs op "lt" | "gt"';
      if (typeof value !== "number" || !Number.isFinite(value)) return "number condition needs a numeric value";
      return null;
    }
    case "contains": {
      const text = (c as { text?: unknown }).text;
      if (!isNonEmptyString(text)) return "contains condition needs non-empty text";
      return null;
    }
    default:
      return `unknown condition kind: ${String(kind)}`;
  }
}

export function validateInterval(v: unknown): string | null {
  if (typeof v !== "number" || !VALID_INTERVALS.includes(v)) {
    return `intervalMinutes must be one of ${VALID_INTERVALS.join(" / ")} (got ${String(v)})`;
  }
  if (v < MIN_MONITOR_INTERVAL_MINUTES) return `intervalMinutes must be >= ${MIN_MONITOR_INTERVAL_MINUTES}`;
  return null;
}

// ── Trial run (§4.2) ────────────────────────────────────────────────────────

export type TrialResult =
  | { ok: true; value: string; fetchMode: "direct" | "tab" }
  | { ok: false; reason: CheckFailureReason; detail: string };

/**
 * Read the URL once without borrowing the user's tab — this is what decides
 * whether the card offers "start monitoring" at all, and it fixes fetchMode
 * up front. Same code path as a real check, so a trial pass means checks work.
 */
export async function trialMonitor(
  url: string,
  target: MonitorTarget,
): Promise<TrialResult> {
  const direct = await extractDirect(url, target);
  if (direct.ok) return { ok: true, value: direct.value, fetchMode: "direct" };
  const viaTab = await extractViaTab(url, target);
  if (viaTab.ok) return { ok: true, value: viaTab.value, fetchMode: "tab" };
  const reportDirect = direct.reason === "login" || direct.reason === "blocked";
  const worse = reportDirect ? direct : viaTab;
  return { ok: false, reason: worse.reason, detail: worse.detail };
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateMonitorInput {
  title: string;
  url: string;
  target: MonitorTarget;
  condition: MonitorCondition;
  intervalMinutes: MonitorIntervalMinutes;
  fetchMode: "direct" | "tab";
  /** 试跑取到的值（作为 changed / list_added 的基线）。 */
  initialValue?: string;
}

export async function createMonitorOp(input: CreateMonitorInput): Promise<OpResult> {
  if (!isNonEmptyString(input.title)) return fail("title is required");
  const urlErr = validateUrl(input.url ?? "");
  if (urlErr) return fail(urlErr);
  if (!isNonEmptyString(input.target?.selector)) return fail("target.selector is required");
  const condErr = validateCondition(input.condition);
  if (condErr) return fail(condErr);
  const intErr = validateInterval(input.intervalMinutes);
  if (intErr) return fail(intErr);

  const existing = await listMonitors();
  if (existing.length >= MAX_MONITORS) {
    return fail(`monitor quota exceeded (max ${MAX_MONITORS}). Delete unused monitors first.`);
  }

  const now = Date.now();
  const sample = input.initialValue ?? input.target.sample ?? "";
  const baseline = evaluateCondition(input.condition, undefined, sample);
  const id = newMonitorId();
  const rec: MonitorRecord = {
    id,
    title: input.title.trim(),
    url: input.url,
    target: { ...input.target, sample },
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
    expiresAt: now + MONITOR_TTL_MS,
    fetchMode: input.fetchMode,
    status: "active",
    lastMet: baseline.ok ? baseline.met : false,
    consecutiveFailures: 0,
    history: sample ? [{ at: now, value: sample, met: baseline.ok ? baseline.met : false }] : [],
    createdAt: now,
    ...(sample ? { lastValue: sample, lastCheckedAt: now } : {}),
  };

  await putMonitor(rec);
  await armMonitor(rec);
  return ok(id);
}

// ── update ───────────────────────────────────────────────────────────────────

export interface UpdateMonitorInput {
  id: string;
  title?: string;
  condition?: MonitorCondition;
  intervalMinutes?: MonitorIntervalMinutes;
}

export async function updateMonitorOp(input: UpdateMonitorInput): Promise<OpResult> {
  if (!isNonEmptyString(input.id)) return fail("id is required");
  const rec = await getMonitor(input.id);
  if (!rec) return fail(`monitor not found: ${input.id}`);

  const patch: Partial<Omit<MonitorRecord, "id">> = {};
  if (input.title !== undefined) {
    if (!isNonEmptyString(input.title)) return fail("title must be a non-empty string");
    patch.title = input.title.trim();
  }
  if (input.condition !== undefined) {
    const err = validateCondition(input.condition);
    if (err) return fail(err);
    patch.condition = input.condition;
    // A new condition restarts the edge state: nothing has been "met" under it.
    patch.lastMet = false;
    patch.lastNotifiedAt = undefined;
  }
  let intervalChanged = false;
  if (input.intervalMinutes !== undefined) {
    const err = validateInterval(input.intervalMinutes);
    if (err) return fail(err);
    patch.intervalMinutes = input.intervalMinutes;
    intervalChanged = true;
  }

  await patchMonitor(rec.id, patch);

  if (intervalChanged && rec.status === "active") {
    const updated = await getMonitor(rec.id);
    if (updated) await armMonitor(updated);
  }
  return ok();
}

// ── delete / pause / resume / check-now ──────────────────────────────────────

export async function deleteMonitorOp(id: string): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const rec = await getMonitor(id);
  if (!rec) return fail(`monitor not found: ${id}`);
  await deleteMonitorRec(id);
  await disarmMonitor(id);
  await deleteInboxByRef(id);
  return ok();
}

export async function pauseMonitorOp(
  id: string,
  reason: MonitorPausedReason = "user",
): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const rec = await getMonitor(id);
  if (!rec) return fail(`monitor not found: ${id}`);
  // An expired monitor is terminal: flipping it to "paused" would produce a
  // record whose expiresAt is already past, which resume then refuses — a
  // zombie state with no way out.
  if (rec.status === "expired") return fail("monitor has expired");
  await disarmMonitor(id);
  await patchMonitor(id, { status: "paused", pausedReason: reason, nextCheckAt: undefined });
  return ok();
}

export async function resumeMonitorOp(id: string): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const rec = await getMonitor(id);
  if (!rec) return fail(`monitor not found: ${id}`);
  if (rec.expiresAt <= Date.now()) {
    return fail("monitor has expired — create a new one");
  }
  await patchMonitor(id, {
    status: "active",
    pausedReason: undefined,
    consecutiveFailures: 0,
  });
  const updated = await getMonitor(id);
  if (updated) await armMonitor(updated);
  return ok();
}

/** Manual "check now" — fire-and-forget through the injected bound check. */
export async function checkMonitorNowOp(id: string): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const rec = await getMonitor(id);
  if (!rec) return fail(`monitor not found: ${id}`);
  if (rec.status !== "active") return fail("monitor is not active");
  void Promise.resolve(checkDep(id)).catch((e) => {
    console.warn(`[monitor-ops] checkNow(${id}) rejected:`, e);
  });
  return ok();
}
