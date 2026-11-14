// The execution capsule — what the overlay collapses into while the agent
// operates the page, and the only surface that survives a navigation.
//
// Rendered by the content script (not the overlay document) on purpose: after
// the page navigates there is no overlay document left, but there is always a
// fresh content script asking the SW "is there a task on this tab?".
//
// Untrusted data never reaches this DOM: labels come from tool names / bounded
// args summaries, and the status line is localized by the SW.

import type { CapsuleAction, OverlayCapsuleState, OverlayUiStrings } from "@/lib/overlay/protocol";

const HOST_ATTR = "data-pie-capsule";
const EDGE = 18;

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.cssText = `position:fixed;right:${EDGE}px;bottom:${EDGE}px;z-index:2147483646;`;
  host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);
  return host;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const STYLE = `
:host { all: initial; }
.wrap { position: relative; font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
.cap {
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 12px 0 14px;
  border-radius: 999px;
  background: var(--pie-cap-bg, #14181d);
  color: #f2f5f8;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.06);
  cursor: default;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6bd49f; }
.dot.run { animation: pulse 1.7s ease-in-out infinite; }
.dot.bad { background: #c9675a; }
.dot.muted { background: #8a929e; }
@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }
.txt { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btns { display: inline-flex; gap: 4px; }
.btn {
  height: 24px; padding: 0 8px; border: 0; border-radius: 6px;
  background: rgba(255,255,255,0.12); color: inherit; font: inherit; cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: rgba(255,255,255,0.2); }
.btn.ghost { background: transparent; color: #c7ced8; }
.btn.ghost:hover { background: rgba(255,255,255,0.1); }
.pop {
  position: absolute; right: 0; bottom: 48px; min-width: 200px; max-width: 300px;
  padding: 8px 10px; border-radius: 10px;
  background: var(--pie-cap-bg, #14181d); color: #dfe5ec;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.06);
  font-weight: 400;
}
.pop[hidden] { display: none; }
.row { display: flex; gap: 6px; padding: 3px 0; align-items: baseline; }
.row .i { color: #6bd49f; }
.row.pending .i { color: #8a929e; }
.row.error .i { color: #c9675a; }
.row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (prefers-color-scheme: light) {
  .cap, .pop { background: var(--pie-cap-bg, #14181d); }
}
`;

export interface CapsuleHandlers {
  onAction: (action: CapsuleAction) => void;
}

function statusText(state: OverlayCapsuleState, strings: OverlayUiStrings): string {
  switch (state.status) {
    case "run":
      return state.label;
    case "done":
      return strings.capsuleDone;
    case "stopped":
      return strings.capsuleStopped;
    case "failed":
      return strings.capsuleFailed;
  }
}

function buttonsHTML(state: OverlayCapsuleState, strings: OverlayUiStrings): string {
  switch (state.status) {
    case "run":
      return `<button class="btn ghost" type="button" data-act="stop">${escapeHtml(strings.capsuleStop)}</button>
              <button class="btn" type="button" data-act="expand">${escapeHtml(strings.capsuleExpand)}</button>`;
    case "failed":
      return `<button class="btn ghost" type="button" data-act="retry">${escapeHtml(strings.capsuleRetry)}</button>
              <button class="btn" type="button" data-act="expand">${escapeHtml(strings.capsulePanel)}</button>`;
    case "done":
    case "stopped":
      return `<button class="btn" type="button" data-act="view">${escapeHtml(strings.capsuleView)}</button>`;
  }
}

export function showCapsule(
  state: OverlayCapsuleState,
  strings: OverlayUiStrings,
  handlers: CapsuleHandlers,
): void {
  const h = ensureHost();
  const shadow = h.shadowRoot!;
  const dotClass = state.status === "run" ? "dot run" : state.status === "failed" ? "dot bad" : "dot muted";
  const steps = state.steps.length
    ? `<div class="pop" hidden>${state.steps
        .map((s, i) => {
          const last = i === state.steps.length - 1;
          const cls = state.status === "failed" && last ? "error" : last && state.status === "run" ? "pending" : "";
          return `<div class="row ${cls}"><span class="i">${cls === "error" ? "!" : cls === "pending" ? "•" : "✓"}</span><span class="t">${escapeHtml(s)}</span></div>`;
        })
        .join("")}</div>`
    : "";

  shadow.innerHTML = `<style>${STYLE}</style>
    <div class="wrap" part="wrap">
      <div class="cap">
        <span class="${dotClass}"></span>
        <span class="txt">${escapeHtml(statusText(state, strings))}</span>
        <span class="btns">${buttonsHTML(state, strings)}</span>
      </div>
      ${steps}
    </div>`;

  const pop = shadow.querySelector<HTMLDivElement>(".pop");
  const wrap = shadow.querySelector<HTMLDivElement>(".wrap");
  if (pop && wrap) {
    wrap.addEventListener("mouseenter", () => { pop.hidden = false; });
    wrap.addEventListener("mouseleave", () => { pop.hidden = true; });
  }

  shadow.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;
    e.stopPropagation();
    handlers.onAction(btn.dataset.act as CapsuleAction);
  });
}

export function hideCapsule(): void {
  host?.remove();
  host = null;
}

export function isCapsuleVisible(): boolean {
  return host !== null;
}

export function setCapsuleSurfaceHidden(value: boolean): void {
  if (!host) return;
  host.style.display = value ? "none" : "block";
}
