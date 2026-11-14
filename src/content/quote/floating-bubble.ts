// Selection bar — the four-button row that appears on a text selection.
//
// Two shapes, decided by whether the selection is editable (see
// `lib/overlay/selection.ts`):
//   read-only  → 问 Pie · 解释 · 翻译 · 引用
//   editable   → 问 Pie · 改写 · 翻译 · 更正式
// plus a "⋯" menu holding "在此网站不显示". Nothing here talks to the
// extension: the caller supplies localized labels and handles the action.
//
// The host attribute stays `data-pie-quote-bubble` so the old quote bubble's
// host-attr based tests / cleanup paths keep working.

const HOST_ATTR = "data-pie-quote-bubble";
const BAR_HEIGHT = 30;
const MARGIN = 8;

import type { OverlayUiStrings } from "@/lib/overlay/protocol";

export type SelectionBarAction =
  | "ask"
  | "explain"
  | "translate"
  | "quote"
  | "rewrite"
  | "hide-site";

let host: HTMLElement | null = null;
let menuOpen = false;

function ensureHost(): HTMLElement {
  if (host) return host;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        height: ${BAR_HEIGHT}px;
        padding: 0 4px;
        border-radius: 9px;
        background: var(--pie-bar-bg, #ffffff);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(20, 24, 29, 0.08);
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        color: #1b2026;
        user-select: none;
      }
      .b {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 7px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        white-space: nowrap;
      }
      .b:hover { background: rgba(20, 24, 29, 0.06); }
      .b:focus-visible { outline: 2px solid #3f5568; outline-offset: 1px; }
      .b.pie b { font-weight: 600; }
      .sep { width: 1px; height: 14px; margin: 0 3px; background: rgba(20, 24, 29, 0.12); }
      .mark {
        width: 13px; height: 13px; border-radius: 50%;
        background: radial-gradient(circle at 34% 30%, #fafbfc 0 52%, #14181d 53% 100%);
        box-shadow: inset 0 0 0 1px rgba(20,24,29,0.12);
      }
      .more { padding: 0 6px; font-size: 13px; letter-spacing: 1px; }
      .menu {
        position: absolute;
        top: ${BAR_HEIGHT + 4}px;
        right: 0;
        min-width: 132px;
        padding: 4px;
        border-radius: 8px;
        background: var(--pie-bar-bg, #ffffff);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(20, 24, 29, 0.08);
      }
      .menu[hidden] { display: none; }
      .mi {
        display: block;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;
      }
      .mi:hover { background: rgba(20, 24, 29, 0.06); }
    </style>
    <div class="bar" role="toolbar"></div>
  `;
  document.documentElement.appendChild(host);
  return host;
}

function buttonHTML(action: SelectionBarAction, label: string, extraClass = ""): string {
  const mark = action === "ask" ? '<span class="mark"></span><b></b>' : "";
  return `<button class="b ${extraClass}" type="button" data-act="${action}">${mark}<span>${escapeHtml(label)}</span></button>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export interface ShowSelectionBarArgs {
  /** Viewport rect of the selection (used for placement). */
  anchorTop: number;
  anchorLeft: number;
  anchorRight: number;
  editable: boolean;
  strings: OverlayUiStrings;
  onAction: (action: SelectionBarAction) => void;
}

export function showSelectionBar(args: ShowSelectionBarArgs): void {
  const h = ensureHost();
  const shadow = h.shadowRoot!;
  const buttons = args.editable
    ? [
        buttonHTML("ask", args.strings.barAsk, "pie"),
        '<span class="sep"></span>',
        buttonHTML("rewrite", args.strings.barRewrite),
        buttonHTML("translate", args.strings.barTranslate),
      ]
    : [
        buttonHTML("ask", args.strings.barAsk, "pie"),
        '<span class="sep"></span>',
        buttonHTML("explain", args.strings.barExplain),
        buttonHTML("translate", args.strings.barTranslate),
        buttonHTML("quote", args.strings.barQuote),
      ];
  const bar = shadow.querySelector<HTMLDivElement>(".bar")!;
  bar.innerHTML = `${buttons.join("")}<span class="sep"></span>
    <button class="b more" type="button" data-act="more" aria-label="${escapeHtml(args.strings.barMore)}" title="${escapeHtml(args.strings.barMore)}">⋯</button>`;
  const existingMenu = shadow.querySelector<HTMLDivElement>(".menu");
  existingMenu?.remove();
  menuOpen = false;

  bar.onclick = (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act!;
    if (act === "more") {
      toggleMenu(args);
      return;
    }
    const action = act as SelectionBarAction;
    hideBubble();
    args.onAction(action);
  };

  // Place: centered over the selection, above it; below when there is no room.
  const width = bar.offsetWidth || 220;
  const above = args.anchorTop - BAR_HEIGHT - MARGIN;
  const below = args.anchorTop + MARGIN;
  h.style.top = `${Math.round(above >= MARGIN ? above : below)}px`;
  const maxLeft = window.innerWidth - width - MARGIN;
  const centered = (args.anchorLeft + args.anchorRight) / 2 - width / 2;
  h.style.left = `${Math.round(Math.max(MARGIN, Math.min(maxLeft, centered)))}px`;
}

function toggleMenu(args: ShowSelectionBarArgs): void {
  const shadow = host?.shadowRoot;
  if (!shadow) return;
  const existing = shadow.querySelector<HTMLDivElement>(".menu");
  if (existing) {
    existing.remove();
    menuOpen = false;
    return;
  }
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = `<button class="mi" type="button" data-act="hide-site">${escapeHtml(args.strings.barHideSite)}</button>`;
  menu.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;
    hideBubble();
    args.onAction("hide-site");
  });
  shadow.appendChild(menu);
  menuOpen = true;
}

export function hideBubble(): void {
  if (!host) return;
  host.remove();
  host = null;
  menuOpen = false;
}

export function __test__isVisible(): boolean {
  return host !== null;
}

export function __test__isMenuOpen(): boolean {
  return menuOpen;
}

/** Bar actions that only exist when the selection is editable. */
export const EDITABLE_BAR_ACTIONS: ReadonlySet<SelectionBarAction> = new Set<SelectionBarAction>([
  "rewrite",
]);
