// src/lib/monitors/condition.ts
//
// Pure condition evaluation for page monitors (§4.2 / §4.8). No chrome.*, no
// IDB — every branch is unit-testable.
//
// Edge-triggering (notify only on false → true) lives in check.ts; this module
// only answers "does the value I just read satisfy the condition".

import type { MonitorCondition } from "./types";

export type ConditionEval =
  /** `met` = condition satisfied. `ok:false` = couldn't evaluate (unparseable
   *  number / empty extraction) — callers count it as a failure, not a miss. */
  | { ok: true; met: boolean }
  | { ok: false; error: string };

/**
 * Extract the first number from a page string. Handles currency prefixes,
 * thousands separators and trailing units ("¥1,999.00", "$2 399", "1.299,00 €"
 * is NOT handled — EU decimal-comma is out of v1 scope).
 */
export function parseNumber(raw: string): number | null {
  const m = raw.replace(/[,\s ]/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Split an extracted list-shaped value (newline-joined items) into items. */
export function splitItems(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function evaluateCondition(
  condition: MonitorCondition,
  prevValue: string | undefined,
  nextValue: string,
): ConditionEval {
  switch (condition.kind) {
    case "changed":
      // First check is the baseline, never a trigger (there is nothing to
      // compare against yet).
      return { ok: true, met: prevValue !== undefined && nextValue !== prevValue };

    case "number": {
      const n = parseNumber(nextValue);
      if (n == null) return { ok: false, error: `no number in extracted value: ${nextValue.slice(0, 80)}` };
      return { ok: true, met: condition.op === "lt" ? n < condition.value : n > condition.value };
    }

    case "contains": {
      const needle = condition.text.trim();
      if (needle.length === 0) return { ok: false, error: "contains condition has empty text" };
      return { ok: true, met: nextValue.toLowerCase().includes(needle.toLowerCase()) };
    }

    case "list_added": {
      const next = splitItems(nextValue);
      if (next.length === 0) return { ok: false, error: "extracted list is empty" };
      // Baseline: first check only records the list.
      if (prevValue === undefined) return { ok: true, met: false };
      const prev = new Set(splitItems(prevValue));
      return { ok: true, met: next.some((item) => !prev.has(item)) };
    }
  }
}

/** Items that are new relative to the previous value (for the notification body). */
export function addedItems(prevValue: string | undefined, nextValue: string): string[] {
  const prev = new Set(splitItems(prevValue ?? ""));
  return splitItems(nextValue).filter((item) => !prev.has(item));
}
