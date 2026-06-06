/**
 * injected-detect.ts
 *
 * ⚠️  SERIALIZATION CONSTRAINT — READ BEFORE EDITING ⚠️
 *
 * This file is executed via chrome.scripting.executeScript which SERIALIZES
 * the function body as a string and reinjects it into the page context.
 * Therefore:
 *
 *   • NO runtime imports are allowed — any `import` other than `import type`
 *     will be SILENTLY DROPPED (type imports are erased at compile time and
 *     are the ONLY allowed form).
 *
 *   • ALL helpers (detectPageProfile, normalizeHeader, resolveAll, …) MUST be
 *     inlined inside `detectStructureInPage`. Closures over module-level
 *     variables are invisible to the injected script.
 *
 *   • When you add or modify detection logic here, you MUST also update the
 *     canonical module source (generate.ts / extract.ts / locator.ts /
 *     columns.ts / profile.ts) AND add a matching assertion in
 *     injected-detect.test.ts so drift is caught automatically.
 *
 * Self-contained injected function for in-page structure detection and
 * sample extraction. The function body is serialized by
 * chrome.scripting.executeScript, so it MUST NOT reference any imports or
 * outer-scope closures. All helpers are inlined.
 *
 * The parity test (injected-detect.test.ts) guards that critical logic copied
 * from generate.ts / extract.ts / locator.ts / columns.ts / profile.ts stays
 * in sync with the modules.
 */

export interface InjectedDetectResult {
  ok: true;
  profile: "classic" | "spa-grid";
  isTable: boolean;
  rowCount: number;
  extraction: {
    container: { signals: { kind: string; value: string; stable: boolean }[] };
    rowLocator: { signals: { kind: string; value: string; stable: boolean }[] };
    fields: { name: string; locator: { signals: { kind: string; value: string; stable: boolean }[] }; attr?: string }[];
    pagination: Record<string, never>;
    stopCondition: { maxPages: 1 };
  };
  sampleRows: Record<string, string>[];
}

export interface InjectedDetectFailure {
  ok: false;
}

export type InjectedDetectOutput = InjectedDetectResult | InjectedDetectFailure;

/**
 * Self-contained injected function. Do NOT add imports or outer-scope
 * references here — executeScript serializes the function body.
 */
export function detectStructureInPage(): InjectedDetectOutput {
  // ── Inline types (cannot import) ──
  type SignalKind = "testid" | "id" | "name" | "aria-label" | "role+name" | "text" | "class" | "column" | "nth";
  interface LocatorSignal { kind: SignalKind; value: string; stable: boolean }
  interface MultiSignalLocator { signals: LocatorSignal[] }
  interface FieldSpec { name: string; locator: MultiSignalLocator; attr?: string }
  type PageProfile = "classic" | "spa-grid";

  // ── Inline: detectPageProfile (from profile.ts) ──
  const HASH_CLASS_RE = [/^css-[a-z0-9]{5,}$/i, /^sc-[a-zA-Z0-9]{5,}$/, /^[a-z][\w]*_[a-z0-9]{5,}$/i];
  function detectPageProfile(root: ParentNode): PageProfile {
    if (root.querySelector('[role="grid"],[role="row"],[role="gridcell"],[aria-colindex]')) {
      return "spa-grid";
    }
    const sample = [...root.querySelectorAll("[class]")].slice(0, 50);
    if (sample.length) {
      const hashed = sample.filter((el) =>
        [...(el as Element).classList].some((c) => HASH_CLASS_RE.some((re) => re.test(c))),
      );
      if (hashed.length / sample.length > 0.3) return "spa-grid";
    }
    return "classic";
  }

  // ── Inline: normalizeHeader (from columns.ts) ──
  function normalizeHeader(s: string | null | undefined): string {
    return (s ?? "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // ── Inline: normText (from locator.ts) ──
  function normText(s: string | null | undefined): string {
    return (s ?? "").replace(/\s+/g, " ").trim();
  }

  // ── Inline: selectorFor (from locator.ts) ──
  function selectorFor(sig: LocatorSignal): string | null {
    switch (sig.kind) {
      case "id": return `[id="${sig.value}"]`;
      case "testid": return sig.value.startsWith("[") ? sig.value : `[data-testid="${sig.value}"]`;
      case "name": return `[name="${sig.value}"]`;
      case "aria-label": return `[aria-label="${sig.value}"]`;
      case "class": return sig.value;
      case "nth": return sig.value;
      default: return null;
    }
  }

  // ── Inline: matchByText (from locator.ts) ──
  function matchByText(root: ParentNode, text: string): Element[] {
    const want = normText(text).toLowerCase();
    if (!want) return [];
    return [...root.querySelectorAll("a,button,[role='button'],[role='link']")].filter((el) =>
      normText(el.textContent).toLowerCase().includes(want),
    );
  }

  // ── Inline: matchByRoleName (from locator.ts) ──
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

  // ── Inline: resolveAll (from locator.ts) ──
  function resolveAll(root: ParentNode, loc: MultiSignalLocator): Element[] {
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
      if (sig.kind === "role+name") {
        const el = matchByRoleName(root, sig.value);
        if (el) return [el];
      }
    }
    return [];
  }

  // ── Inline: resolveOne (from locator.ts) ──
  function resolveOne(root: ParentNode, loc: MultiSignalLocator): Element | null {
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

  // ── Inline: isAriaGrid (from extract.ts) ──
  function isAriaGrid(container: ParentNode): boolean {
    const el = container as Element;
    if (el.getAttribute && el.getAttribute("role") === "grid") return true;
    const firstRow = container.querySelector('[role="row"]');
    if (firstRow && firstRow.querySelector('[role="gridcell"]')) return true;
    return false;
  }

  // ── Inline: ariaGridColMap (from extract.ts) ──
  function ariaGridColMap(container: ParentNode, wanted: string[]): Record<string, number> {
    const headers = [...container.querySelectorAll('[role="columnheader"]')];
    const headerIndices: number[] = headers.map((h, i) => {
      const col = h.getAttribute("aria-colindex");
      return col != null ? parseInt(col, 10) - 1 : i;
    });
    const normMap: Record<string, number> = {};
    headers.forEach((h, i) => {
      const t = normalizeHeader(h.textContent);
      if (t) normMap[t] = headerIndices[i];
    });
    const out: Record<string, number> = {};
    for (const w of wanted) {
      const nw = normalizeHeader(w);
      let idx = normMap[nw] ?? -1;
      if (idx < 0) {
        const match = Object.entries(normMap).find(([k]) => k.includes(nw));
        idx = match ? match[1] : -1;
      }
      out[w] = idx;
    }
    return out;
  }

  // ── Inline: extractAriaCell (from extract.ts) ──
  function extractAriaCell(row: Element, colIdx: number): string {
    if (colIdx < 0) return "";
    const byColIndex = row.querySelector(`[role="gridcell"][aria-colindex="${colIdx + 1}"]`);
    if (byColIndex) return (byColIndex.textContent ?? "").replace(/\s+/g, " ").trim();
    const cells = [...row.querySelectorAll('[role="gridcell"]')];
    if (cells[colIdx]) return (cells[colIdx].textContent ?? "").replace(/\s+/g, " ").trim();
    return "";
  }

  // ── Inline: extractField (from extract.ts) ──
  function extractField(row: Element, f: FieldSpec, colMap: Record<string, number>, useAriaGrid = false): string {
    for (const sig of f.locator.signals) {
      if (sig.kind === "column") {
        const idx = colMap[sig.value];
        if (idx != null && idx >= 0) {
          if (useAriaGrid) {
            const v = extractAriaCell(row, idx);
            if (v) return v;
          } else {
            const v = normText(row.children[idx]?.textContent);
            if (v) return v;
          }
        }
        continue;
      }
      const sel = selectorFor(sig);
      if (sel) {
        const el = row.querySelector(sel);
        if (el) {
          const v = normText(f.attr ? el.getAttribute(f.attr) : el.textContent);
          if (v) return v;
        }
      }
    }
    return "";
  }

  // ── Inline: isValidRow (from extract.ts) ──
  function isValidRow(row: Element, minCells?: number): boolean {
    if (minCells != null && row.children.length < minCells) return false;
    return true;
  }

  // ── Inline: generate helpers (from generate.ts) ──
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

  function generateLocator(el: Element, _root: ParentNode, profile: PageProfile): MultiSignalLocator {
    const signals: LocatorSignal[] = [];
    const push = (kind: LocatorSignal["kind"], value: string, stable: boolean) => {
      if (value) signals.push({ kind, value, stable });
    };

    const testid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    push("testid", testid ? `[data-testid="${testid}"]` : "", !!testid);
    if (el.id) push("id", el.id, true);
    const nameAttr = el.getAttribute("name");
    if (nameAttr) push("name", nameAttr, true);
    const aria = el.getAttribute("aria-label");

    if (profile === "spa-grid") {
      if (aria) push("aria-label", aria, true);
      const role = el.getAttribute("role");
      if (role) push("role+name", `${role}|${norm(aria || el.textContent)}`, false);
      push("text", actionableText(el), false);
      const cls = stableClassSelector(el);
      if (cls) push("class", cls, false);
    } else {
      const cls = stableClassSelector(el);
      if (cls) push("class", cls, true);
      if (aria) push("aria-label", aria, true);
      push("text", actionableText(el), false);
    }

    push("nth", nthSelector(el), false);
    return { signals };
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

  function rowLocatorForGroup(rows: Element[], _root: ParentNode, _profile: PageProfile): MultiSignalLocator {
    const sampleRow = rows[0];
    const tag = sampleRow.tagName.toLowerCase();
    const sharedClasses = [...sampleRow.classList].filter((c) =>
      !isHashed(c) && c.length > 1 && rows.every((r) => r.classList.contains(c))
    );
    const signals: LocatorSignal[] = [];
    if (sharedClasses.length > 0) {
      signals.push({ kind: "class", value: `${tag}.${sharedClasses.join(".")}`, stable: true });
    }
    const nthSel = nthSelector(sampleRow);
    signals.push({ kind: "nth", value: nthSel, stable: false });
    return { signals };
  }

  function findAriaGridContainer(root: ParentNode): Element | null {
    const direct = (root as Element).getAttribute?.("role") === "grid" ? (root as Element) : null;
    if (direct) return direct;
    return (root as ParentNode).querySelector('[role="grid"]') ?? null;
  }

  // ── Inline: detectStructure (from generate.ts) ──
  function detectStructure(root: ParentNode): {
    container: MultiSignalLocator;
    rowLocator: MultiSignalLocator;
    fields: FieldSpec[];
    isTable: boolean;
  } | null {
    const profile = detectPageProfile(root);

    // ARIA-grid fast path
    const ariaGridEl = findAriaGridContainer(root);
    if (ariaGridEl) {
      const containerEl = ariaGridEl;
      const headerRow = containerEl.querySelector('[role="row"]:has([role="columnheader"])') ??
        [...containerEl.querySelectorAll('[role="row"]')].find(
          (r) => r.querySelector('[role="columnheader"]') !== null,
        );
      const headers = headerRow ? [...headerRow.querySelectorAll('[role="columnheader"]')] : [];
      const dataRows = [...containerEl.querySelectorAll('[role="row"]')].filter(
        (r) => r.querySelector('[role="gridcell"]') !== null,
      );
      if (!dataRows.length) return null;

      const fields: FieldSpec[] = headers.map((h, i) => {
        const headerText = norm(h.textContent);
        const colSignalValue = headerText || `col_${i + 1}`;
        return {
          name: normalizeHeader(headerText) || `col_${i + 1}`,
          locator: { signals: [{ kind: "column" as SignalKind, value: colSignalValue, stable: true }] },
        };
      });

      if (!fields.length) {
        const sampleRow = dataRows[0];
        const cells = [...sampleRow.querySelectorAll('[role="gridcell"]')];
        cells.forEach((_, i) => {
          fields.push({
            name: `col_${i + 1}`,
            locator: { signals: [{ kind: "column" as SignalKind, value: `col_${i + 1}`, stable: true }] },
          });
        });
      }

      return {
        container: generateLocator(containerEl, root, profile),
        rowLocator: { signals: [{ kind: "role+name" as SignalKind, value: "row|", stable: false }] },
        fields,
        isTable: false,
      };
    }

    // Classic repeating-group path
    const groups = repeatingGroups(root);
    if (!groups.length) return null;
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
          locator: { signals: [{ kind: "column" as SignalKind, value: headers[i] || `col_${i + 1}`, stable: true }] },
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

  // ── Main: run detection + extract sample ──
  const root: ParentNode = document;
  const detected = detectStructure(root);
  if (!detected) return { ok: false };

  const profile = detectPageProfile(root);
  const { container: containerLoc, rowLocator, fields, isTable } = detected;

  // Build the minimal extraction spec (single page)
  const extraction = {
    container: containerLoc,
    rowLocator,
    fields,
    pagination: {} as Record<string, never>,
    stopCondition: { maxPages: 1 as const },
  };

  // Now extract a sample (up to 5 rows)
  const containerEl: ParentNode = resolveOne(root, containerLoc) ?? root;
  const ariaGrid = isAriaGrid(containerEl);

  let allRows: Element[];
  if (ariaGrid) {
    allRows = [...containerEl.querySelectorAll('[role="row"]')].filter(
      (r) =>
        r.querySelector('[role="gridcell"]') !== null &&
        !r.querySelector('[role="columnheader"]'),
    );
    allRows = allRows.filter((r) => isValidRow(r));
  } else {
    allRows = resolveAll(containerEl, rowLocator).filter((r) => isValidRow(r));
  }

  let colMap: Record<string, number> = {};
  const wanted = fields.flatMap((f) => f.locator.signals.filter((s) => s.kind === "column").map((s) => s.value));
  if (wanted.length) {
    if (ariaGrid) {
      colMap = ariaGridColMap(containerEl, wanted);
    } else {
      const headers = [...containerEl.querySelectorAll("th")].map((th) => th.textContent ?? "");
      // mapColumns inline
      const normHeaders = headers.map(normalizeHeader);
      for (const w of wanted) {
        const nw = normalizeHeader(w);
        let idx = normHeaders.findIndex((h) => h === nw);
        if (idx < 0) idx = normHeaders.findIndex((h) => h.length > 0 && h.includes(nw));
        colMap[w] = idx;
      }
    }
  }

  const sampleRows: Record<string, string>[] = [];
  for (const row of allRows.slice(0, 5)) {
    const rec: Record<string, string> = {};
    let any = false;
    for (const f of fields) {
      rec[f.name] = extractField(row, f, colMap, ariaGrid);
      if (rec[f.name]) any = true;
    }
    if (any) sampleRows.push(rec);
  }

  return {
    ok: true,
    profile,
    isTable,
    rowCount: allRows.length,
    extraction,
    sampleRows,
  };
}

/**
 * Caller wrapper: injects detectStructureInPage into the given tab and returns results.
 * Must be called from a privileged extension context (background SW).
 */
export async function detectStructureOnTab(tabId: number): Promise<InjectedDetectOutput> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: detectStructureInPage,
  });
  const result = results[0]?.result as InjectedDetectOutput | undefined;
  return result ?? { ok: false };
}
