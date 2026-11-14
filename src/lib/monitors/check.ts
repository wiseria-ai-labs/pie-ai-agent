// src/lib/monitors/check.ts
//
// §4.3 — one monitor check. No model call in the normal path.
//
//   1. extract (direct fetch + offscreen parse, upgrading to a hidden tab when
//      the server HTML doesn't contain the target / needs a session cookie)
//   2. evaluate the condition against the previous value
//   3. edge-trigger: notify only on false → true, at most once per hour
//   4. on failure: count it; 3 consecutive → pause + one notification + one
//      "needs action" activity entry
//   5. re-arm the next alarm with ±10% jitter
//
// Everything chrome-facing is injectable so the whole flow is testable without
// an extension runtime.

import { addInboxEntry } from "@/lib/inbox/store";
import { addedItems, evaluateCondition } from "./condition";
import { extractDirect, extractViaTab, type ExtractOutcome } from "./extract";
import { notifyMonitorHit, notifyMonitorPaused } from "./notify";
import {
  disarmMonitor,
  setNextCheckAlarm,
  nextCheckAt as jitteredNextCheckAt,
} from "./scheduler";
import { appendMonitorResult, getMonitor, patchMonitor } from "./store";
import {
  MONITOR_FAILURE_PAUSE_THRESHOLD,
  MONITOR_NOTIFY_COOLDOWN_MS,
  type MonitorCondition,
  type MonitorHistoryEntry,
  type MonitorPausedReason,
  type MonitorRecord,
} from "./types";

// ── Same-origin serialization (§4.3.6) ───────────────────────────────────────

/**
 * Conditions whose `met` is an EVENT ("this poll saw something new") rather
 * than a STATE. See the trigger gate in checkMonitor.
 */
const EVENT_CONDITIONS: ReadonlySet<MonitorCondition["kind"]> = new Set(["changed", "list_added"]);

const domainChains = new Map<string, Promise<unknown>>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Run `fn` after every previously-queued check for the same origin settles.
 * §4.3.6 — 同域名请求串行. The chain is dropped once it drains so the map stays
 * bounded by concurrently-watched origins.
 */
export async function withDomainLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const key = originOf(url);
  const prev = domainChains.get(key) ?? Promise.resolve();
  const started = prev.catch(() => undefined).then(fn);
  const settle = started.catch(() => undefined);
  domainChains.set(key, settle);
  void settle.finally(() => {
    if (domainChains.get(key) === settle) domainChains.delete(key);
  });
  return started;
}

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface CheckDeps {
  now: () => number;
  random: () => number;
  extractDirect: (url: string, rec: MonitorRecord) => Promise<ExtractOutcome>;
  extractViaTab: (url: string, rec: MonitorRecord) => Promise<ExtractOutcome>;
  notifyHit: typeof notifyMonitorHit;
  notifyPaused: typeof notifyMonitorPaused;
  addInbox: typeof addInboxEntry;
}

export const defaultCheckDeps: CheckDeps = {
  now: () => Date.now(),
  random: () => Math.random(),
  extractDirect: (url, rec) => extractDirect(url, rec.target),
  extractViaTab: (url, rec) =>
    extractViaTab(url, rec.target, {
      onTabOpen: (tabId) => patchMonitor(rec.id, { activeTabId: tabId }),
      onTabClose: () => patchMonitor(rec.id, { activeTabId: undefined }),
    }),
  notifyHit: notifyMonitorHit,
  notifyPaused: notifyMonitorPaused,
  addInbox: addInboxEntry,
};

// ── Copy helpers ─────────────────────────────────────────────────────────────

/** Language-neutral evidence line (`¥2,199 → ¥1,999`). */
export function evidenceLine(prev: string | undefined, next: string): string {
  const clip = (s: string) => s.replace(/\n/g, " · ").slice(0, 120);
  const n = clip(next);
  return prev == null ? n : `${clip(prev)} → ${n}`;
}

function failureToPausedReason(
  reason: Extract<ExtractOutcome, { ok: false }>["reason"],
): MonitorPausedReason {
  switch (reason) {
    case "login":
      return "login";
    case "blocked":
      return "blocked";
    case "not_found":
      return "not_found";
    case "network":
      return "network";
  }
}

// ── Extraction with §4.3.2 upgrade ──────────────────────────────────────────

/**
 * Read the current value.
 *
 * fetcher:"direct" tries the plain SW fetch first; ANY failure upgrades to a
 * hidden tab once (JS-rendered pages, SameSite=Strict cookies, bot walls). If
 * the tab succeeds the monitor switches to `tab` permanently — the "带不上
 * cookie 就走 tab" compatibility the spec asks for. `tab` monitors go straight
 * to the tab path and never downgrade.
 */
export async function readValue(
  rec: MonitorRecord,
  deps: CheckDeps,
): Promise<{ outcome: ExtractOutcome; upgradedToTab: boolean }> {
  if (rec.fetchMode === "tab") {
    return { outcome: await deps.extractViaTab(rec.url, rec), upgradedToTab: false };
  }

  const direct = await deps.extractDirect(rec.url, rec);
  if (direct.ok) return { outcome: direct, upgradedToTab: false };

  const viaTab = await deps.extractViaTab(rec.url, rec);
  if (viaTab.ok) return { outcome: viaTab, upgradedToTab: true };
  // Neither worked — report the direct-mode failure when it was a hard
  // site-level signal (login / blocked), else the tab's (rendered content).
  const reportDirect = direct.reason === "login" || direct.reason === "blocked";
  return { outcome: reportDirect ? direct : viaTab, upgradedToTab: false };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function checkMonitor(
  monitorId: string,
  deps: CheckDeps = defaultCheckDeps,
): Promise<void> {
  const rec = await getMonitor(monitorId);
  if (!rec) return;
  if (rec.status !== "active") {
    await disarmMonitor(monitorId);
    return;
  }

  const now = deps.now();
  if (rec.expiresAt <= now) {
    await disarmMonitor(monitorId);
    await patchMonitor(monitorId, { status: "expired", nextCheckAt: undefined });
    return;
  }

  const { outcome, upgradedToTab } = await withDomainLock(rec.url, () => readValue(rec, deps));

  if (!outcome.ok) {
    await handleFailure(rec, outcome, deps);
    return;
  }

  const evalResult = evaluateCondition(rec.condition, rec.lastValue, outcome.value);
  if (!evalResult.ok) {
    await handleFailure(rec, { ok: false, reason: "not_found", detail: evalResult.error }, deps);
    return;
  }

  const met = evalResult.met;
  // "变化记录" records value changes, not every poll: a 15-minute check that
  // returns the same number 96 times a day is noise. The very first value is a
  // baseline, not a change.
  const changed = rec.lastValue !== undefined && rec.lastValue !== outcome.value;
  // Trigger gate. State conditions (number / contains) are edge-triggered:
  // false → true only. Event conditions (changed / list_added) already mean
  // "this poll observed something new", so gating them against the previous
  // poll's `met` would let a value that changes on every check notify exactly
  // once and then go permanently silent — the 1-hour cooldown is their
  // anti-spam gate instead.
  const edgeFire = EVENT_CONDITIONS.has(rec.condition.kind) || !rec.lastMet;
  const shouldNotify =
    met && edgeFire && now - (rec.lastNotifiedAt ?? 0) >= MONITOR_NOTIFY_COOLDOWN_MS;

  const entry: MonitorHistoryEntry | null = changed || met !== rec.lastMet
    ? { at: now, value: outcome.value, met }
    : null;

  const nextAt = jitteredNextCheckAt(rec, now, deps.random);
  await setNextCheckAlarm(rec.id, nextAt);

  await appendMonitorResult(monitorId, entry, {
    lastValue: outcome.value,
    lastCheckedAt: now,
    lastMet: met,
    consecutiveFailures: 0,
    fetchMode: upgradedToTab ? "tab" : rec.fetchMode,
    nextCheckAt: nextAt,
    ...(shouldNotify ? { lastNotifiedAt: now } : {}),
  });

  if (!shouldNotify) return;

  // §4.5 — the body is the evidence. For a list condition "old → new" would be
  // an unreadable wall of text, so name the new rows instead.
  const body =
    rec.condition.kind === "list_added"
      ? addedItems(rec.lastValue, outcome.value).slice(0, 5).join(" · ")
      : evidenceLine(rec.lastValue, outcome.value);
  await deps.addInbox({
    source: "monitor",
    refId: monitorId,
    kind: "triggered",
    title: rec.title,
    body,
    data: {
      reason: "triggered",
      url: rec.url,
      ...(rec.lastValue != null ? { from: rec.lastValue.slice(0, 120) } : {}),
      to: outcome.value.slice(0, 120),
    },
    at: now,
  });
  await deps.notifyHit({ monitorId, title: rec.title, body });
}

async function handleFailure(
  rec: MonitorRecord,
  failure: Extract<ExtractOutcome, { ok: false }>,
  deps: CheckDeps,
): Promise<void> {
  const now = deps.now();
  const failures = rec.consecutiveFailures + 1;

  if (failures < MONITOR_FAILURE_PAUSE_THRESHOLD) {
    const nextAt = jitteredNextCheckAt(rec, now, deps.random);
    await setNextCheckAlarm(rec.id, nextAt);
    await patchMonitor(rec.id, {
      consecutiveFailures: failures,
      lastCheckedAt: now,
      nextCheckAt: nextAt,
    });
    return;
  }

  // §4.3.5 — pause once, notify once, leave one "needs action" activity entry.
  const reason = failureToPausedReason(failure.reason);
  await disarmMonitor(rec.id);
  await patchMonitor(rec.id, {
    status: "paused",
    pausedReason: reason,
    consecutiveFailures: failures,
    lastCheckedAt: now,
    nextCheckAt: undefined,
  });
  await deps.addInbox({
    source: "monitor",
    refId: rec.id,
    kind: "needs_action",
    title: rec.title,
    body: failure.detail.slice(0, 160),
    data: { reason, failures: String(failures), url: rec.url },
    at: now,
  });
  await deps.notifyPaused({
    monitorId: rec.id,
    title: rec.title,
    body: `Paused after ${failures} failed checks (${reason}).`,
  });
}
