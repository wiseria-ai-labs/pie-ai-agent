// src/lib/recipes/generate.ts
import type { MultiSignalLocator, LocatorSignal, PageProfile } from "./types";
import { detectPageProfile } from "./profile";
import { normalizeHeader } from "./columns";
import type { FieldSpec } from "./types";

const HASH_CLASS = [/^css-[a-z0-9]{5,}$/i, /^sc-[a-zA-Z0-9]{5,}$/, /^[a-z][\w]*_[a-z0-9]{5,}$/i];
const isHashed = (c: string) => HASH_CLASS.some((re) => re.test(c));
const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

function stableClassSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const good = [...el.classList].filter((c) => !isHashed(c) && c.length > 1);
  return good.length ? `${tag}.${good.join(".")}` : null;
}

function nthSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const idx = [...parent.children].filter((c) => c.tagName === el.tagName).indexOf(el) + 1;
  return `${tag}:nth-of-type(${idx})`;
}

function actionableText(el: Element): string {
  if (!/^(a|button|summary)$/i.test(el.tagName) && el.getAttribute("role") !== "button" && el.getAttribute("role") !== "link") return "";
  return norm(el.textContent).slice(0, 40);
}

export function generateLocator(el: Element, _root: ParentNode, profile: PageProfile): MultiSignalLocator {
  const signals: LocatorSignal[] = [];
  const push = (kind: LocatorSignal["kind"], value: string, stable: boolean) => {
    if (value) signals.push({ kind, value, stable });
  };

  // tier-0 稳定属性(有就用,两画像都靠前)
  const testid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
  push("testid", testid ? `[data-testid="${testid}"]` : "", !!testid);
  if (el.id) push("id", el.id, true);
  const nameAttr = el.getAttribute("name");
  if (nameAttr) push("name", nameAttr, true);
  const aria = el.getAttribute("aria-label");

  if (profile === "spa-grid") {
    // SPA:aria / role+name / 文本 优先,哈希 class 不可信
    if (aria) push("aria-label", aria, true);
    const role = el.getAttribute("role");
    if (role) push("role+name", `${role}|${norm(aria || el.textContent)}`, false);
    push("text", actionableText(el), false);
    const cls = stableClassSelector(el); // 仅非哈希
    if (cls) push("class", cls, false);
  } else {
    // classic:稳定 class 优先
    const cls = stableClassSelector(el);
    if (cls) push("class", cls, true);
    if (aria) push("aria-label", aria, true);
    push("text", actionableText(el), false);
  }

  // 兜底总在
  push("nth", nthSelector(el), false);
  return { signals };
}

// ─── detectStructure ───────────────────────────────────────────────────────

export interface DetectedStructure {
  container: MultiSignalLocator;
  rowLocator: MultiSignalLocator;
  fields: FieldSpec[];
  isTable: boolean;
}

function repeatingGroups(root: ParentNode): Element[][] {
  const groups: Element[][] = [];
  const parents = new Set<Element>();
  root.querySelectorAll("*").forEach((el) => el.parentElement && parents.add(el.parentElement));
  for (const p of parents) {
    const byTagClass = new Map<string, Element[]>();
    for (const c of [...p.children]) {
      const key = c.tagName + "." + [...c.classList].sort().join(".");
      (byTagClass.get(key) ?? byTagClass.set(key, []).get(key)!).push(c);
    }
    for (const arr of byTagClass.values()) if (arr.length >= 3) groups.push(arr);
  }
  return groups;
}

/**
 * Build a row locator that matches ALL sibling rows (not just nth-of-type).
 * Uses a shared class selector like `tag.sharedClass` when rows share classes,
 * so resolveAll(root, rowLocator) returns all rows.
 */
function rowLocatorForGroup(rows: Element[], root: ParentNode, profile: PageProfile): MultiSignalLocator {
  const sampleRow = rows[0];
  const tag = sampleRow.tagName.toLowerCase();

  // Find classes shared by ALL rows in the group
  const sharedClasses = [...sampleRow.classList].filter((c) =>
    !isHashed(c) && c.length > 1 && rows.every((r) => r.classList.contains(c))
  );

  const signals: LocatorSignal[] = [];

  if (sharedClasses.length > 0) {
    // Use shared class selector — will match all sibling rows
    signals.push({ kind: "class", value: `${tag}.${sharedClasses.join(".")}`, stable: true });
  }

  // Fallback: nth (single-row fallback — won't match all siblings, but kept as safety)
  const nthSel = nthSelector(sampleRow);
  signals.push({ kind: "nth", value: nthSel, stable: false });

  return { signals };
}

// ── ARIA-grid detection ───────────────────────────────────────────────────────

/**
 * Returns the nearest [role=grid] ancestor/self, or null if none exists.
 * Used by detectStructure to find ARIA-grid containers.
 */
function findAriaGridContainer(root: ParentNode): Element | null {
  // Direct role=grid element
  const direct = (root as Element).getAttribute?.("role") === "grid" ? (root as Element) : null;
  if (direct) return direct;
  return (root as ParentNode).querySelector('[role="grid"]') ?? null;
}

export function detectStructure(root: ParentNode): DetectedStructure | null {
  const profile = detectPageProfile(root);

  // ── ARIA-grid fast path ──────────────────────────────────────────────────
  const ariaGridEl = findAriaGridContainer(root);
  if (ariaGridEl) {
    const containerEl = ariaGridEl;

    // Header row: [role=row] that contains [role=columnheader]
    const headerRow = containerEl.querySelector('[role="row"]:has([role="columnheader"])') ??
      [...containerEl.querySelectorAll('[role="row"]')].find(
        (r) => r.querySelector('[role="columnheader"]') !== null,
      );

    const headers = headerRow
      ? [...headerRow.querySelectorAll('[role="columnheader"]')]
      : [];

    // Data rows: [role=row] containing gridcells (not header rows)
    const dataRows = [...containerEl.querySelectorAll('[role="row"]')].filter(
      (r) => r.querySelector('[role="gridcell"]') !== null,
    );

    if (!dataRows.length) return null;

    // Build fields from column headers (aria-colindex → column signal)
    const fields: FieldSpec[] = headers.map((h, i) => {
      const headerText = norm(h.textContent);
      const colSignalValue = headerText || `col_${i + 1}`;
      return {
        name: normalizeHeader(headerText) || `col_${i + 1}`,
        locator: { signals: [{ kind: "column", value: colSignalValue, stable: true }] },
      };
    });

    // If no headers detected, fall back to gridcell count in first data row
    if (!fields.length) {
      const sampleRow = dataRows[0];
      const cells = [...sampleRow.querySelectorAll('[role="gridcell"]')];
      cells.forEach((_, i) => {
        fields.push({
          name: `col_${i + 1}`,
          locator: { signals: [{ kind: "column", value: `col_${i + 1}`, stable: true }] },
        });
      });
    }

    return {
      container: generateLocator(containerEl, root, profile),
      rowLocator: {
        signals: [{ kind: "role+name", value: "row|", stable: false }],
      },
      fields,
      isTable: false,
    };
  }

  // ── Classic repeating-group path ─────────────────────────────────────────
  const groups = repeatingGroups(root);
  if (!groups.length) return null;
  // 取「行数 × 行内文本量」最大的组
  groups.sort((a, b) => b.length * (b[0]?.textContent?.length ?? 0) - a.length * (a[0]?.textContent?.length ?? 0));
  const rows = groups[0];
  const sampleRow = rows[0];
  const containerEl = sampleRow.parentElement!;
  const isTable = sampleRow.tagName === "TR";

  const fields: FieldSpec[] = [];
  if (isTable) {
    const table = sampleRow.closest("table");
    const headers = table ? [...table.querySelectorAll("th")].map((th) => th.textContent ?? "") : [];
    [...sampleRow.children].forEach((cell, i) => {
      const headerName = headers[i] ? normalizeHeader(headers[i]) : `col_${i + 1}`;
      fields.push({
        name: headerName || `col_${i + 1}`,
        locator: { signals: [{ kind: "column", value: headers[i] || `col_${i + 1}`, stable: true }] },
      });
    });
  } else {
    const leaves = [...sampleRow.querySelectorAll("*")].filter((e) => e.children.length === 0 && norm(e.textContent));
    (leaves.length ? leaves : [sampleRow]).forEach((leaf, i) => {
      fields.push({ name: `field_${i + 1}`, locator: generateLocator(leaf, sampleRow, profile) });
    });
  }

  return {
    container: generateLocator(containerEl, root, profile),
    rowLocator: rowLocatorForGroup(rows, root, profile),
    fields,
    isTable,
  };
}
