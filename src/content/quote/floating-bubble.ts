const HOST_ATTR = "data-pie-quote-bubble";
const BUBBLE_HEIGHT = 24;
const BUBBLE_WIDTH = 24;
const MARGIN = 6;

let host: HTMLElement | null = null;
let currentClick: (() => void) | null = null;

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
      .b {
        width: 24px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.06);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 80ms ease;
      }
      .b:hover { transform: translateY(-1px); }
      .b:active { transform: translateY(0); }
      .b svg { display: block; }
    </style>
    <button class="b" type="button" aria-label="添加为引用" title="添加为引用">
      <!-- Vailie IP mesh (F6) — ported from scripts/render-icons.html's
           LAYERS_SMALL recipe (the same tight-decay 16/32px config used for
           the extension's own toolbar icon): silver-grey body, blue welling
           up from below, a peach dot upper-right, all fading to alpha 0 at
           the edges — no clip, no outline; the shape IS the gradient, same
           as VailieMark.tsx. Self-contained (no external refs) since this is
           injected into arbitrary pages via a content script. Layers are
           painted body → blue → peach so the peach dot sits on top, matching
           LAYERS_SMALL's documented CSS paint order (first entry = topmost). -->
      <svg width="24" height="24" viewBox="0 0 128 128" aria-hidden="true">
        <defs>
          <radialGradient id="vailie-quote-mesh-body" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(64 58.88) scale(61.44 58.88)">
            <stop offset="0%" stop-color="rgb(199,210,222)" stop-opacity="1"/>
            <stop offset="50%" stop-color="rgb(199,210,222)" stop-opacity="1"/>
            <stop offset="95%" stop-color="rgb(199,210,222)" stop-opacity="0"/>
            <stop offset="100%" stop-color="rgb(199,210,222)" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="vailie-quote-mesh-blue" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(53.76 87.04) scale(48.64 38.4)">
            <stop offset="0%" stop-color="rgb(124,184,255)" stop-opacity=".75"/>
            <stop offset="30%" stop-color="rgb(124,184,255)" stop-opacity=".75"/>
            <stop offset="85%" stop-color="rgb(124,184,255)" stop-opacity="0"/>
            <stop offset="100%" stop-color="rgb(124,184,255)" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="vailie-quote-mesh-peach" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(84.48 38.4) scale(33.28 30.72)">
            <stop offset="0%" stop-color="rgb(255,159,178)" stop-opacity=".9"/>
            <stop offset="25%" stop-color="rgb(255,159,178)" stop-opacity=".9"/>
            <stop offset="80%" stop-color="rgb(255,159,178)" stop-opacity="0"/>
            <stop offset="100%" stop-color="rgb(255,159,178)" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="128" height="128" fill="url(#vailie-quote-mesh-body)"/>
        <rect width="128" height="128" fill="url(#vailie-quote-mesh-blue)"/>
        <rect width="128" height="128" fill="url(#vailie-quote-mesh-peach)"/>
      </svg>
    </button>
  `;
  shadow.querySelector<HTMLButtonElement>("button")!.addEventListener("click", () => {
    const cb = currentClick;
    hideBubble();
    cb?.();
  });
  document.documentElement.appendChild(host);
  return host;
}

export function showBubble(args: { anchorTop: number; anchorLeft: number; onClick: () => void }): void {
  const h = ensureHost();
  currentClick = args.onClick;
  const above = args.anchorTop - BUBBLE_HEIGHT - MARGIN;
  const top = above >= 0 ? above : args.anchorTop + MARGIN;
  const maxLeft = window.innerWidth - BUBBLE_WIDTH - MARGIN;
  const left = Math.max(MARGIN, Math.min(maxLeft, args.anchorLeft));
  h.style.top = `${Math.round(top)}px`;
  h.style.left = `${Math.round(left)}px`;
}

export function hideBubble(): void {
  if (!host) return;
  host.remove();
  host = null;
  currentClick = null;
}

export function __test__isVisible(): boolean {
  return host !== null;
}
