import { isCdpInputEnabled } from "@/lib/cdp-input-enabled";
import type { CdpSession } from "@/background/cdp-session";
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { elementToPagePoint, type GeometryError } from "@/lib/dom-actions/geometry";
import { execActInTab } from "@/lib/dom-actions/exec-act";
import { withActionSettle, type ActionSettleOptions } from "../wait-for-settle";
import { pageAtlasStore } from "./page-atlas/state";

import {
  getScreenshotGeometry,
  invalidateScreenshotGeometry,
  mapScreenshotPoint,
  probeViewport,
} from "../screenshot-geometry";

/** click may navigate (links, SPA routes): wait for the new page, not the old one. */
const CLICK_SETTLE: ActionSettleOptions = {
  detectNavigation: true,
  onNavigated: (tabId) => pageAtlasStore.invalidateTab(tabId),
};

/**
 * Internal: dispatch a single CDP mouse event at the given page coords.
 */
export async function dispatchMouseAt(
  session: CdpSession,
  x: number,
  y: number,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  opts: { button?: MouseButton; clickCount?: number } = {},
): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : (opts.button ?? "left"),
    clickCount: type === "mouseMoved" ? 0 : (opts.clickCount ?? 1),
    pointerType: "mouse",
  });
}

export type MouseButton = "left" | "right" | "middle";

export type CdpGateResult = { ok: true } | { ok: false; error: string };

interface RequireCdpInputArgs {
  sessionId: string;
  requestConsent: (sessionId: string) => Promise<boolean>;
}

/**
 * Tri-state gate for CDP-dependent tools. Reads cdp_input_enabled:
 *   - true → ok=true
 *   - false → ok=false, error="disabled in Settings"
 *   - undefined → invoke requestConsent (inline guide); true→ok, false/throw→error
 */
export interface MouseToolDeps {
  /**
   * Lazy attach (or reuse) a CdpSession bound to this task.
   * Curried by runAgentLoop with the task's signal/ownerToken.
   */
  acquireSession: (tabId: number) => Promise<CdpSession>;
  /**
   * Session id for the current chat task — used to route the inline
   * consent guide through the correct sidepanel port.
   */
  sessionId: string;
  /**
   * Trigger sidepanel consent flow when the flag is unset (undefined).
   * Bound to requestCdpInputConsent in loop.ts.
   */
  requestConsent: (sessionId: string) => Promise<boolean>;
}

function geometryErrorToActionResult(e: GeometryError): ActionResult {
  switch (e.kind) {
    case "element-not-found":
      return {
        success: false,
        error: `Element not found at index ${e.index}. Page changed; call read_page again.`,
      };
    case "element-not-visible":
      return {
        success: false,
        error: `Element [${e.index}] has zero size (display:none / removed from layout). Call read_page again.`,
      };
    default: {
      // Exhaustiveness check — if GeometryError gains a new kind, this
      // triggers a compile error so the mapping must be updated.
      const _exhaustive: never = e;
      throw new Error(`Unhandled GeometryError kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function buildHoverTool(deps: MouseToolDeps): Tool {
  return {
    name: "hover",
    description:
      `Hover the mouse over an element by its data-pie-idx from the latest read_page <interactive_index>. Uses real mouse events (CDP). After hovering, call read_page again to see any newly revealed elements.

USE WHEN:
- An element reveals new content on mouseover — dropdown menus, tooltips, hover cards.

**Top frame only** (frameId 0). Hover is not supported inside iframes — click directly, or re-run read_page to check whether the content is already visible.

**DO NOT USE WHEN:**
- You want to activate or open the element — use click.`,
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from the latest read_page <interactive_index>.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the element from the latest read_page <interactive_index>.",
        },
      },
      required: ["frameId", "elementIndex"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      // Models sometimes send frameId as a JSON string ("5"); coerce before
      // routing. undefined/NaN → 0 (CDP top-frame path).
      const a = args as { frameId: number | string; elementIndex: number };
      const rawFrameId = Number(a.frameId);
      const frameId = Number.isFinite(rawFrameId) ? rawFrameId : 0;

      if (frameId !== 0) {
        return {
          success: false,
          error:
            "hover is only supported in the top frame for now. For elements inside iframes, try clicking directly, or use read_page to check whether the target content is already visible.",
        };
      }

      const gate = await requireCdpInput({
        sessionId: deps.sessionId,
        requestConsent: deps.requestConsent,
      });
      if (!gate.ok) return { success: false, error: gate.error };

      let session: CdpSession;
      try {
        session = await deps.acquireSession(ctx.tabId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Another debugger|conflict/i.test(msg)) {
          return {
            success: false,
            error: `CDP attach failed: another debugger is attached to this tab (DevTools or another agent task). Close it and retry.`,
          };
        }
        return { success: false, error: `CDP attach failed: ${msg}` };
      }

      return withActionSettle(ctx.tabId, async () => {
        const point = await elementToPagePoint(ctx.tabId, a.elementIndex);
        if ("kind" in point) return geometryErrorToActionResult(point);

        await dispatchMouseAt(session, point.x, point.y, "mouseMoved");
        return {
          success: true,
          observation: `Hovered [${a.elementIndex}] at (${Math.round(point.x)},${Math.round(point.y)}). New content may have appeared; call read_page to observe.`,
        };
      });
    },
  };
}

export function buildClickTool(deps: MouseToolDeps): Tool {
  return {
    name: "click",
    description:
      `Click an interactive element by its data-pie-idx from the latest read_page <interactive_index>. If the element is gone (page changed), returns 'Element not found' — call read_page({mode:"interactive"}) again for current indices.
Top-frame elements (frameId 0) get real mouse events (CDP). Elements inside iframes (frameId > 0) get synthetic in-frame events — works on virtually all sites, but controls demanding trusted input may ignore it.

USE WHEN:
- You need to activate a clickable element — button, link, checkbox, radio, menu item, tab.

**DO NOT USE WHEN:**
- You want to enter text — use type (or set_editor_value / dispatch_keyboard_input for editors).
- You want to pick a native <select> option — use select.
- You only need to reveal hover content — use hover.`,
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from the latest read_page <interactive_index>.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the element from the latest read_page <interactive_index>.",
        },
      },
      required: ["frameId", "elementIndex"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      // Models sometimes send frameId as a JSON string ("5"); coerce before
      // routing. undefined/NaN → 0 (CDP top-frame path).
      const a = args as { frameId: number | string; elementIndex: number };
      const rawFrameId = Number(a.frameId);
      const frameId = Number.isFinite(rawFrameId) ? rawFrameId : 0;

      if (frameId !== 0) {
        // Subframe path — in-frame synthetic click. No CDP: the chrome↔CDP
        // frame mapping was the broken link (OOPIF frames invisible to the
        // root session). executeScript reaches exactly the frames read_page
        // can snapshot, so anything the agent can see it can click.
        // Settle signals are top-frame scoped: the mutation tracker injects at
        // {tabId} and nav events with frameId!==0 are ignored — in-iframe-only
        // updates just ride out the quiet floor.
        return withActionSettle(ctx.tabId, async () => {
          const result = await execActInTab(
            ctx.tabId,
            { op: "click", idx: a.elementIndex },
            frameId,
          );
          if (!result.ok) return { success: false, error: result.error };
          return {
            success: true,
            observation: `Clicked [${a.elementIndex}] in frame ${frameId} via synthetic events (real mouse input is top-frame only). If the page did not react, the control may require trusted input.`,
          };
        }, CLICK_SETTLE);
      }

      const gate = await requireCdpInput({
        sessionId: deps.sessionId,
        requestConsent: deps.requestConsent,
      });
      if (!gate.ok) return { success: false, error: gate.error };

      let session: CdpSession;
      try {
        session = await deps.acquireSession(ctx.tabId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Another debugger|conflict/i.test(msg)) {
          return {
            success: false,
            error: `CDP attach failed: another debugger is attached to this tab (DevTools or another agent task). Close it and retry.`,
          };
        }
        return { success: false, error: `CDP attach failed: ${msg}` };
      }

      return withActionSettle(ctx.tabId, async () => {
        const point = await elementToPagePoint(ctx.tabId, a.elementIndex);
        if ("kind" in point) return geometryErrorToActionResult(point);

        await dispatchMouseAt(session, point.x, point.y, "mouseMoved");
        await dispatchMouseAt(session, point.x, point.y, "mousePressed");
        await dispatchMouseAt(session, point.x, point.y, "mouseReleased");

        return {
          success: true,
          observation: `Clicked [${a.elementIndex}] at (${Math.round(point.x)},${Math.round(point.y)}).`,
        };
      }, CLICK_SETTLE);
    },
  };
}

const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "right", "middle"];

export function buildClickAtTool(deps: MouseToolDeps): Tool {
  return {
    name: "click_at",
    description:
      `Click at a pixel position in the LATEST capture_visible_tab screenshot (x,y in that image's pixels; mapped to the viewport for you). Real mouse events (CDP), top frame. clickCount 2 selects a word, 3 a paragraph/line.

USE WHEN:
- The target is drawn on a canvas or is otherwise missing from read_page's <interactive_index> — Google Docs / Sheets text, Figma-like editors, maps, charts.

ALWAYS call capture_visible_tab right before, and again after any scroll / key press / typing / click — older screenshots are rejected.
Google Docs: prefer placing the caret by text (see press_key) over pixels; pixel clicks on text are imprecise. After typing, capture_visible_tab to verify placement; if wrong, press_key mod+Z immediately.

**DO NOT USE WHEN:**
- The target has a data-pie-idx in read_page — use click (exact, survives layout shifts).
- You only have a capture_fullpage_tab image — its coordinates are page-relative; take capture_visible_tab.`,
    parameters: {
      type: "object",
      properties: {
        x: {
          type: "number",
          description: "X in pixels of the latest capture_visible_tab image (0 = left edge).",
        },
        y: {
          type: "number",
          description: "Y in pixels of the latest capture_visible_tab image (0 = top edge).",
        },
        clickCount: {
          type: "number",
          enum: [1, 2, 3],
          description: "1 = click (default), 2 = double-click (select word), 3 = triple-click (select paragraph).",
        },
        button: {
          type: "string",
          enum: MOUSE_BUTTONS,
          description: 'Mouse button. Default "left".',
        },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { x: number | string; y: number | string; clickCount?: number | string; button?: string };
      const x = Number(a.x);
      const y = Number(a.y);
      const clickCount = a.clickCount === undefined ? 1 : Number(a.clickCount);
      if (![1, 2, 3].includes(clickCount)) {
        return { success: false, error: `clickCount must be 1, 2 or 3 (got ${String(a.clickCount)}).` };
      }
      const button = (a.button ?? "left") as MouseButton;
      if (!MOUSE_BUTTONS.includes(button)) {
        return { success: false, error: `button must be one of ${MOUSE_BUTTONS.join(", ")} (got ${String(a.button)}).` };
      }

      // Cheap pre-check so a doomed click never prompts for CDP consent or
      // attaches the debugger. NOT authoritative — see the re-check below.
      const precheck = mapScreenshotPoint(
        getScreenshotGeometry(deps.sessionId, ctx.tabId),
        { x, y },
        await probeViewport(ctx.tabId),
        Date.now(),
      );
      if (!precheck.ok) return { success: false, error: precheck.error };

      const gate = await requireCdpInput({
        sessionId: deps.sessionId,
        requestConsent: deps.requestConsent,
      });
      if (!gate.ok) return { success: false, error: gate.error };

      let session: CdpSession;
      try {
        session = await deps.acquireSession(ctx.tabId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Another debugger|conflict/i.test(msg)) {
          return {
            success: false,
            error: `CDP attach failed: another debugger is attached to this tab (DevTools or another agent task). Close it and retry.`,
          };
        }
        return { success: false, error: `CDP attach failed: ${msg}` };
      }

      try {
        // Authoritative check, right before dispatch: the consent card can sit
        // open for minutes (user may scroll / resize meanwhile), and the first
        // debugger attach shows Chrome's "started debugging" infobar, which
        // shrinks the viewport. Either makes the pre-check result stale.
        const mapped = mapScreenshotPoint(
          getScreenshotGeometry(deps.sessionId, ctx.tabId),
          { x, y },
          await probeViewport(ctx.tabId),
          Date.now(),
        );
        if (!mapped.ok) return { success: false, error: mapped.error };
        return await withActionSettle(ctx.tabId, async () => {
          await dispatchMouseAt(session, mapped.x, mapped.y, "mouseMoved");
          // Chromium recognises double/triple clicks from a press/release run
          // with an increasing clickCount (same as Playwright's click()).
          for (let i = 1; i <= clickCount; i++) {
            await dispatchMouseAt(session, mapped.x, mapped.y, "mousePressed", { button, clickCount: i });
            await dispatchMouseAt(session, mapped.x, mapped.y, "mouseReleased", { button, clickCount: i });
          }
          const kind = clickCount === 1 ? "Clicked" : clickCount === 2 ? "Double-clicked" : "Triple-clicked";
          return {
            success: true,
            observation: `${kind} (${button}) at screenshot (${Math.round(x)},${Math.round(y)}) → viewport (${Math.round(mapped.x)},${Math.round(mapped.y)}). The screenshot is now stale; call capture_visible_tab to see the result.`,
          };
        });
      } finally {
        // The click itself may scroll, focus or reflow — never reuse the old geometry.
        invalidateScreenshotGeometry(deps.sessionId, ctx.tabId);
      }
    },
  };
}

export async function requireCdpInput(
  args: RequireCdpInputArgs,
): Promise<CdpGateResult> {
  const flag = await isCdpInputEnabled();
  if (flag === true) return { ok: true };
  // undefined (never configured) OR false (previously disabled) — both prompt
  // the user to enable CDP input now. Re-prompting on `false` is intentional:
  // when a task genuinely needs CDP we let the user authorize on the spot
  // instead of dead-ending and asking them to go dig through Settings.
  try {
    const granted = await args.requestConsent(args.sessionId);
    if (granted) return { ok: true };
    return {
      ok: false,
      error: "CDP input not enabled — the user declined. This action requires CDP and can't be performed otherwise.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\(panel closed\)/i.test(msg)) {
      return { ok: false, error: "Onboarding cancelled (panel closed)." };
    }
    return { ok: false, error: `CDP consent error: ${msg}` };
  }
}
