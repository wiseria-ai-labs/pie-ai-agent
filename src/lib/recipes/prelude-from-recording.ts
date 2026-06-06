// src/lib/recipes/prelude-from-recording.ts
import type { RecordedAction } from "../recording/types";
import type { ActionStep } from "./recipe-types";
import type { MultiSignalLocator } from "./types";

/**
 * Build a MultiSignalLocator from a RecordedAction.
 * Uses selectorHint as a "class" signal (most stable) and extracts
 * quoted text from label as a "text" fallback signal.
 */
function locFromRecorded(a: RecordedAction): MultiSignalLocator {
  const signals: MultiSignalLocator["signals"] = [];

  if (a.selectorHint) {
    signals.push({
      kind: "class" as const,
      value: a.selectorHint,
      stable: !a.unstable,
    });
  }

  // Extract quoted visible text from label, e.g. "按钮 'Submit'" → "Submit"
  const m = /['"]([^'"]+)['"]/.exec(a.label);
  if (m) {
    signals.push({ kind: "text" as const, value: m[1], stable: false });
  }

  return { signals };
}

/**
 * Convert a recorded action trace into an ActionStep prelude.
 * scroll and keypress actions are dropped (not meaningful for prelude replay).
 * navigate actions use the action's url field.
 */
export function recordingToPrelude(actions: RecordedAction[]): ActionStep[] {
  const steps: ActionStep[] = [];

  for (const a of actions) {
    if (a.type === "navigate") {
      steps.push({ type: "navigate", url: a.url });
      continue;
    }
    if (a.type === "scroll" || a.type === "keypress") {
      continue;
    }

    const step: ActionStep = {
      type: a.type as ActionStep["type"],
      locator: locFromRecorded(a),
    };
    if (a.value != null) {
      step.value = a.value;
    }
    steps.push(step);
  }

  return steps;
}
