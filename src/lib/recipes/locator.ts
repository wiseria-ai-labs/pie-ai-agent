// src/lib/recipes/locator.ts
import type { MultiSignalLocator, LocatorSignal } from "./types";

export function normText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Returns a CSS selector for selector-kinds, or null for kinds needing custom logic. */
export function selectorFor(sig: LocatorSignal): string | null {
  switch (sig.kind) {
    case "id": return `[id="${sig.value}"]`;
    case "testid": return sig.value.startsWith("[") ? sig.value : `[data-testid="${sig.value}"]`;
    case "name": return `[name="${sig.value}"]`;
    case "aria-label": return `[aria-label="${sig.value}"]`;
    case "class": return sig.value;   // full CSS selector
    case "nth": return sig.value;     // full nth selector
    default: return null;             // text / role+name / column handled by callers
  }
}

function matchByText(root: ParentNode, text: string): Element[] {
  const want = normText(text).toLowerCase();
  if (!want) return [];
  return [...root.querySelectorAll("a,button,[role='button'],[role='link']")].filter((el) =>
    normText(el.textContent).toLowerCase().includes(want),
  );
}

function matchByRoleName(root: ParentNode, value: string): Element | null {
  const [role, name] = value.split("|");
  const want = normText(name).toLowerCase();
  const cands = [...root.querySelectorAll(`[role="${role}"], ${role}`)];
  return (
    cands.find((el) => {
      const label = normText(el.getAttribute("aria-label") || el.textContent).toLowerCase();
      return want ? label.includes(want) : true;
    }) ?? null
  );
}

export function resolveAll(root: ParentNode, loc: MultiSignalLocator): Element[] {
  for (const sig of loc.signals) {
    const sel = selectorFor(sig);
    if (sel) {
      const els = [...root.querySelectorAll(sel)];
      if (els.length) return els;
      continue;
    }
    if (sig.kind === "text") {
      const els = matchByText(root, sig.value);
      if (els.length) return els;
    }
  }
  return [];
}

export function resolveOne(root: ParentNode, loc: MultiSignalLocator): Element | null {
  for (const sig of loc.signals) {
    const sel = selectorFor(sig);
    if (sel) {
      const el = root.querySelector(sel);
      if (el) return el;
      continue;
    }
    if (sig.kind === "text") {
      const el = matchByText(root, sig.value)[0];
      if (el) return el;
    }
    if (sig.kind === "role+name") {
      const el = matchByRoleName(root, sig.value);
      if (el) return el;
    }
  }
  return null;
}
