// Selection facts the overlay depends on: is the text editable, and how do we
// put a rewritten string back without breaking the page?
//
// Written as plain DOM helpers (no chrome.*) so the whole decision path — the
// part that decides "replace" vs "copy only" — is unit-testable outside a
// browser. Everything here runs inside the page's content script.

/** A selection captured while it was still live. */
export type EditableTarget =
  | {
      kind: "field";
      element: HTMLInputElement | HTMLTextAreaElement;
      /** Character offsets in `element.value` at capture time. */
      start: number;
      end: number;
      text: string;
    }
  | { kind: "editable"; element: HTMLElement; text: string };

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

export function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return false;
}

function closestEditable(el: Element | null): HTMLElement | null {
  let node: Element | null = el;
  while (node) {
    if (node instanceof HTMLElement && node.isContentEditable) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * A non-collapsed selection living inside a text field.
 *
 * Chrome does NOT expose `<input>` / `<textarea>` selections through
 * `window.getSelection()` (it returns an empty selection while the field's own
 * `selectionStart/End` carry the truth), so this is the only way the bar can
 * appear over an editor — and the only way a field rewrite can be verified.
 */
export function fieldSelectionTarget(
  el: Element | null,
): Extract<EditableTarget, { kind: "field" }> | null {
  if (!isTextField(el)) return null;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start === null || end === null || end <= start) return null;
  const text = el.value.slice(start, end);
  if (text.trim().length === 0) return null;
  return { kind: "field", element: el, start, end, text };
}

/**
 * Where the selection lives, if it is editable at all.
 *
 * Order matters: a field selection never appears in `window.getSelection()`, so
 * it is checked first; then a selection inside a contenteditable ancestor.
 */
export function editableTargetFor(
  sel: Selection | null,
  active: Element | null,
  doc: Document = document,
): EditableTarget | null {
  const field = fieldSelectionTarget(active) ?? fieldSelectionTarget(doc.activeElement);
  if (field) return field;

  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString();
  if (text.trim().length === 0) return null;

  const anchor = sel.anchorNode;
  const anchorEl =
    anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);

  for (const candidate of [active, anchorEl, doc.activeElement]) {
    if (isTextField(candidate)) {
      const start = candidate.selectionStart;
      const end = candidate.selectionEnd;
      if (start === null || end === null || end <= start) continue;
      return { kind: "field", element: candidate, start, end, text };
    }
  }

  const editable = closestEditable(anchorEl) ?? closestEditable(active);
  if (editable) return { kind: "editable", element: editable, text };
  if (doc.designMode === "on" && doc.body) {
    return { kind: "editable", element: doc.body, text };
  }
  return null;
}

/** Range of the only occurrence of `needle` inside `root`, or null when it is
 *  missing or ambiguous (ambiguity = we might overwrite the wrong sentence). */
export function findUniqueTextRange(root: Node, needle: string): Range | null {
  if (!needle) return null;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let found: Range | null = null;
  let count = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    let i = text.indexOf(needle);
    while (i >= 0 && count < 2) {
      count += 1;
      if (!found) {
        const range = doc.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        found = range;
      }
      i = text.indexOf(needle, i + needle.length);
    }
    if (count > 1) return null;
    node = walker.nextNode();
  }
  return count === 1 ? found : null;
}

/**
 * Focus the page before writing.
 *
 * The click that triggered the write happened inside the overlay iframe, so
 * the PAGE document is not the focused document and `execCommand('insertText')`
 * silently does nothing (it returns true and inserts nowhere). Refocusing the
 * page window first is what makes the field path work at all.
 */
function focusPage(element: HTMLElement): void {
  const doc = element.ownerDocument;
  try {
    if (!doc.hasFocus()) doc.defaultView?.focus();
  } catch {
    // Cross-origin / sandboxed frames — focus() may throw; keep going.
  }
  element.focus({ preventScroll: true });
}

function insertText(range: Range, element: HTMLElement, text: string): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  focusPage(element);
  sel.removeAllRanges();
  sel.addRange(range);
  // execCommand keeps the editor's own undo stack and fires `input`, which is
  // exactly what the prototype asks for (⌘Z still works in the page).
  return document.execCommand("insertText", false, text);
}

function replaceInField(
  element: HTMLInputElement | HTMLTextAreaElement,
  original: string,
  text: string,
): boolean {
  const liveStart = element.selectionStart;
  const liveEnd = element.selectionEnd;
  if (
    liveStart !== null &&
    liveEnd !== null &&
    element.value.slice(liveStart, liveEnd) === original
  ) {
    focusPage(element);
    element.setSelectionRange(liveStart, liveEnd);
    return (
      document.execCommand("insertText", false, text) &&
      element.value.slice(liveStart, liveStart + text.length) === text
    );
  }

  const first = element.value.indexOf(original);
  const last = element.value.lastIndexOf(original);
  // Missing (user edited / page re-rendered) or ambiguous (two identical
  // sentences — writing to the wrong one is worse than not writing).
  if (first < 0 || first !== last) return false;
  focusPage(element);
  element.setSelectionRange(first, first + original.length);
  return (
    document.execCommand("insertText", false, text) &&
    element.value.slice(first, first + text.length) === text
  );
}

/**
 * Write `text` over `original` inside the captured target.
 *
 * Returns false for every "can't do it safely" answer — the caller degrades
 * the button to copy and tells the user the text already changed.
 */
export function applyReplacement(
  target: EditableTarget,
  original: string,
  text: string,
): boolean {
  if (original.length === 0) return false;
  if (target.kind === "field") {
    if (!target.element.isConnected) return false;
    return replaceInField(target.element, original, text);
  }
  if (!target.element.isConnected) return false;
  const range = findUniqueTextRange(target.element, original);
  if (!range) return false;
  return insertText(range, target.element, text);
}

/** Current page selection as the overlay protocol shape wants it. */
export function captureSelectionSnapshot(
  sel: Selection | null = window.getSelection(),
  active: Element | null = document.activeElement,
): { text: string; editable: boolean; url: string } | null {
  // Field selections are invisible to window.getSelection() — see
  // fieldSelectionTarget.
  const field = fieldSelectionTarget(active) ?? fieldSelectionTarget(document.activeElement);
  if (field) {
    return { text: field.text.trim().slice(0, 8000), editable: true, url: location.href };
  }
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (text.length === 0) return null;
  const target = editableTargetFor(sel, active);
  return { text: text.slice(0, 8000), editable: target !== null, url: location.href };
}

/** Bounding rect of the selection's last line (where the bar should sit). */
export function selectionAnchorRect(sel: Selection | null = window.getSelection()): DOMRect | null {
  // A focused text field has no Range to measure — the field itself is the anchor.
  const field = fieldSelectionTarget(document.activeElement);
  if (field) return field.element.getBoundingClientRect();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(sel.rangeCount - 1);
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
}
