/**
 * read_page mode="text" — readable-text extraction.
 *
 * Injected via `chrome.scripting.executeScript({ func: extractPageTextInjected,
 * args: [opts] })`, so it MUST stay self-contained: no imports, no references
 * to module-level values, all helpers declared inside the function body.
 *
 * Output is a light markdown rendering of what a reader sees: headings as
 * `#`/`##`/…, list items `- `, links `[text](absolute href)`, table rows
 * `a | b | c`, block elements on their own lines. Hidden subtrees and
 * non-content elements (script/style/svg/…) are skipped.
 */

export interface PageTextOptions {
  /** Max chars of `text` returned (caller clamps). */
  maxChars: number;
  /** "main" prefers `<main>` / `[role=main]` when it has substantial text. */
  scope: "main" | "page";
}

export interface PageTextResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  /** Full extracted length before truncation (lower bound if the hard cap hit). */
  totalChars: number;
  /** Which root was read: "main" or "body". */
  root: "main" | "body";
}

export function extractPageTextInjected(opts: PageTextOptions): PageTextResult {
  const maxChars = Math.max(1, Math.floor(opts?.maxChars || 12000));
  const scope = opts?.scope === "page" ? "page" : "main";
  // Hard stop for pathological pages — keeps the walk bounded.
  const HARD_CAP = 1_000_000;
  const MAIN_MIN_CHARS = 200;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE", "CANVAS", "IFRAME", "OBJECT",
    "EMBED", "HEAD", "META", "LINK", "INPUT", "SELECT", "TEXTAREA", "OPTION", "VIDEO", "AUDIO",
  ]);
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "HEADER", "HR", "MAIN", "NAV", "OL", "P",
    "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "THEAD", "TFOOT", "UL", "CAPTION",
  ]);

  const out: string[] = [];
  let outChars = 0;
  let buf = "";
  let prefix = "";
  // >0 while collecting inline text for a link / table cell: block boundaries
  // become spaces instead of new lines.
  let inlineDepth = 0;
  let listDepth = 0;
  let stopped = false;

  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

  function push(line: string) {
    out.push(line);
    outChars += line.length + 1;
    if (outChars > HARD_CAP) stopped = true;
  }

  function flush() {
    if (inlineDepth > 0) {
      buf += " ";
      return;
    }
    const t = collapse(buf);
    if (t) push(prefix + t);
    buf = "";
    prefix = "";
  }

  function styleOf(el: Element): CSSStyleDeclaration | null {
    try {
      return window.getComputedStyle(el);
    } catch {
      return null;
    }
  }

  function isHiddenEl(el: Element, style: CSSStyleDeclaration | null): boolean {
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (style && style.display === "none") return true;
    return false;
  }

  function headingLevel(el: Element): number {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return Number(tag[1]);
    if (el.getAttribute("role") === "heading") {
      const lvl = Number(el.getAttribute("aria-level"));
      return lvl >= 1 && lvl <= 6 ? lvl : 2;
    }
    return 0;
  }

  /** Run `fn` with a fresh buffer and return the collapsed inline text it produced. */
  function collectInline(fn: () => void): string {
    const savedBuf = buf;
    buf = "";
    inlineDepth++;
    try {
      fn();
    } finally {
      inlineDepth--;
    }
    const text = collapse(buf);
    buf = savedBuf;
    return text;
  }

  function walkChildren(node: Node) {
    const root = (node as Element).shadowRoot;
    if (root) {
      for (const child of Array.from(root.childNodes)) {
        if (stopped) return;
        walk(child, true);
      }
    }
    for (const child of Array.from(node.childNodes)) {
      if (stopped) return;
      walk(child, true);
    }
  }

  function walk(node: Node, parentVisible: boolean) {
    if (stopped) return;
    if (node.nodeType === 3) {
      if (parentVisible) buf += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    const style = styleOf(el);
    if (isHiddenEl(el, style)) return;
    // visibility inherits and can be overridden by a descendant, so a hidden
    // element only drops its own text; children re-check their own style.
    const visible = !(style && (style.visibility === "hidden" || style.visibility === "collapse"));
    const display = style?.display ?? "";

    if (tag === "BR") {
      flush();
      return;
    }
    if (tag === "IMG") return;

    const level = headingLevel(el);
    if (level > 0 && inlineDepth === 0) {
      flush();
      if (out.length > 0 && out[out.length - 1] !== "") push("");
      prefix = "#".repeat(level) + " ";
      walkChildren(el);
      flush();
      return;
    }

    if (tag === "A" && el.hasAttribute("href")) {
      const rawHref = (el.getAttribute("href") ?? "").trim();
      const href = (el as HTMLAnchorElement).href || rawHref;
      let text = collectInline(() => walkChildren(el));
      if (!text) {
        text = collapse(
          el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.querySelector("img[alt]")?.getAttribute("alt") ||
            "",
        );
      }
      if (!text) return;
      const isJs = /^\s*javascript:/i.test(rawHref) || /^javascript:/i.test(href);
      if (isJs || rawHref.startsWith("#") || !href) {
        buf += ` ${text} `;
      } else {
        buf += ` [${text.replace(/[[\]]/g, "")}](${href}) `;
      }
      return;
    }

    if ((tag === "TR" || el.getAttribute("role") === "row") && inlineDepth === 0) {
      flush();
      const cells: string[] = [];
      for (const cell of Array.from(el.children)) {
        if (stopped) break;
        const ctag = cell.tagName.toUpperCase();
        if (SKIP_TAGS.has(ctag)) continue;
        const cstyle = styleOf(cell);
        if (isHiddenEl(cell, cstyle)) continue;
        cells.push(collectInline(() => walkChildren(cell)));
      }
      if (cells.some((c) => c)) push(cells.join(" | "));
      return;
    }

    const isListItem = tag === "LI" || el.getAttribute("role") === "listitem";
    if (isListItem && inlineDepth === 0) {
      flush();
      prefix = "  ".repeat(Math.max(0, listDepth - 1)) + "- ";
      walkChildren(el);
      flush();
      return;
    }

    const isList = tag === "UL" || tag === "OL" || el.getAttribute("role") === "list";
    const isBlock =
      BLOCK_TAGS.has(tag) ||
      (display !== "" && !display.startsWith("inline") && display !== "contents");

    if (isBlock) flush();
    if (isList) listDepth++;
    if (visible) {
      walkChildren(el);
    } else {
      // Skip own text nodes, still visit element children.
      for (const child of Array.from(el.children)) {
        if (stopped) break;
        walk(child, false);
      }
    }
    if (isList) listDepth--;
    if (isBlock) flush();
  }

  const body = document.body ?? document.documentElement;
  let rootEl: Element | null = body;
  let rootKind: "main" | "body" = "body";
  if (scope === "main") {
    const mains = Array.from(document.querySelectorAll("main, [role=main]"));
    let best: Element | null = null;
    let bestLen = 0;
    for (const m of mains) {
      const len = collapse((m as HTMLElement).innerText ?? m.textContent ?? "").length;
      if (len > bestLen) {
        best = m;
        bestLen = len;
      }
    }
    if (best && bestLen >= MAIN_MIN_CHARS) {
      rootEl = best;
      rootKind = "main";
    }
  }
  if (rootEl) walk(rootEl, true);
  flush();

  // Dedupe consecutive identical lines, collapse blank-line runs.
  const lines: string[] = [];
  for (const line of out) {
    const prev = lines[lines.length - 1];
    if (line === "" && (lines.length === 0 || prev === "")) continue;
    if (line !== "" && line === prev) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const full = lines.join("\n");

  let text = full;
  let truncated = false;
  if (full.length > maxChars) {
    truncated = true;
    text = full.slice(0, maxChars);
    // Prefer cutting at a line boundary when one is reasonably close.
    const nl = text.lastIndexOf("\n");
    if (nl > maxChars * 0.8) text = text.slice(0, nl);
  }

  return {
    url: location.href,
    title: document.title,
    text,
    truncated: truncated || stopped,
    totalChars: full.length,
    root: rootKind,
  };
}
