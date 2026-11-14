// Where a page-DOM tool will act, as far as the SW can tell from its args.
// The page side resolves this into a rectangle (content/overlay/page-guard.ts);
// keeping the arg parsing here makes it unit-testable without chrome.*.

import type { PageOperationTarget } from "./protocol";

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function pageOperationTarget(tool: string, args: unknown): PageOperationTarget {
  const a = (args ?? {}) as Record<string, unknown>;
  const frameId = num(a.frameId) ?? 0;
  switch (tool) {
    case "press_key":
    case "dispatch_keyboard_input": {
      // Keyboard lands on whatever is focused; dispatch_keyboard_input may
      // click an element first (`after_element_index`).
      const after = num(a.after_element_index ?? a.afterElementIndex);
      return after !== undefined ? { frameId, elementIndex: after } : { activeElement: true };
    }
    case "scroll": {
      // No element arg in the tool schema: it scrolls the frame's viewport,
      // which cannot be occluded by the card (no hit test happens).
      return { viewport: true };
    }
    case "click":
    case "hover":
    case "type":
    case "select":
    case "set_editor_value":
      return { frameId, elementIndex: num(a.elementIndex) };
    default:
      return {};
  }
}
