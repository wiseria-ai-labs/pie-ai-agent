/**
 * Issue #27 — post-action page-settle wait.
 *
 * The agent loop's per-iteration observation pulls URL from
 * `chrome.tabs.get` and DOM elements from `chrome.scripting.executeScript`.
 * These two APIs see different moments of the navigation lifecycle: tab
 * metadata updates at navigation commit / `history.pushState`, while the
 * scripting target's DOM may still be the outgoing document or be
 * mid-swap. After a click that triggers a real navigation, a Turbo /
 * pushState route change, or an async DOM update (AJAX content load),
 * the next iteration would race the page state and report stale elements
 * back to the model — which then re-clicked the same submit button two
 * or three times before getting through.
 *
 * The fix lives at the action level: clicks and key dispatches that may
 * mutate the page wait for any consequences to settle before resolving
 * their tool result. The next iteration then snapshots a stable page.
 *
 * Two activity signals are tracked in parallel:
 *
 *   1. **SW-side `chrome.webNavigation` events** — `onCommitted` for real
 *      cross-document navigations; `onHistoryStateUpdated` for SPA
 *      pushState route changes (Turbo, React Router, Vue Router…). These
 *      survive page tear-down because they fire in the SW, not the page.
 *
 *   2. **Page-side `window.__pieMutAt`** — fed by a global MutationObserver
 *      installed by `installMutationTracker` before the action runs.
 *      Polled after the action via `readMutationTimestamp`. Catches async
 *      DOM updates that don't trigger any navigation event — clicking
 *      "like" on a tweet, opening an AJAX-loaded sub-form, infinite-scroll
 *      content arriving, etc. Synchronous mutations (dropdown / accordion /
 *      modal toggle) bump it inside the click handler so the post-click
 *      quiet wait still lets them settle for one quiet window.
 *
 * Cap behavior: the wait exits when either (a) the time since the last
 * observed activity reaches `quietMs`, or (b) the total elapsed time
 * since the action returned reaches `maxMs`. The cap defends against
 * pages with continuous mutations (live dashboards, animation-heavy
 * landing pages) that would otherwise wedge the loop.
 *
 * #471 — `detectNavigation` (click): 500 ms of quiet is not enough for an
 * SPA that pushes the URL first and swaps content after a fetch. The click
 * fingerprints the top frame (URL / title / first h1|h2), watches
 * `navObserveMs` for a navigation to start (top-frame webNavigation event,
 * fingerprint change, document teardown), and if one did, polls until the
 * page changed + parsed + quiet + no visible loading indicator (≤ navMaxMs;
 * URL-only changes get `urlOnlyGraceMs` for the title to follow). It then
 * clears every frame's data-pie-idx + the tab's page atlases and says what
 * happened in the observation. No navigation → the plain quiet settle.
 */

import type { ActionResult } from "../dom-actions/types";
import { executeScriptAllFrames } from "./inject-all-frames";
import { pageAtlasStore } from "./tools/page-atlas/state";

/**
 * Self-contained injected helper. Idempotent install of a global
 * MutationObserver on document.body that updates `window.__pieMutAt`
 * to `Date.now()` on every childList / subtree mutation. Re-calling
 * the function on a tab where the observer is already installed bumps
 * the baseline timestamp without leaking a second observer.
 *
 * MUST be self-contained for `chrome.scripting.executeScript`: no
 * imports, no closures, no outer-scope references at runtime.
 */
function installMutationTracker(): void {
  type W = { __pieMutAt?: number; __pieMutObs?: MutationObserver };
  const w = window as unknown as W;
  if (w.__pieMutObs) {
    // Idempotent re-call: just bump the baseline so the post-action
    // quiet check measures from "now" rather than the install time of
    // a prior action.
    w.__pieMutAt = Date.now();
    return;
  }
  const installedAt = Date.now();
  w.__pieMutAt = installedAt;
  (w as W & { __pieMutN?: number }).__pieMutN = 0;
  const obs = new MutationObserver((records) => {
    const ww = window as unknown as W & { __pieMutN?: number };
    // #471 — "did anything change" counter for the no-effect note; counts
    // attribute flips too (aria-expanded / class toggles). Quiet timing
    // stays childList-only so attribute animations don't stall the settle.
    ww.__pieMutN = (ww.__pieMutN ?? 0) + 1;
    if (records.some((r) => r.type === "childList")) ww.__pieMutAt = Date.now();
  });
  // `document.body` is null very early in load (before <body> parsed);
  // fall back to `document` so we still register top-level changes.
  obs.observe(document.body ?? document, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  w.__pieMutObs = obs;
}

function readMutationTimestamp(): number {
  return (window as unknown as { __pieMutAt?: number }).__pieMutAt ?? 0;
}

/** #471 — top-frame page fingerprint + load-state snapshot. */
export interface NavProbe {
  url: string;
  title: string;
  /** First h1, else first h2 — SPA route swaps usually change it. */
  heading: string;
  readyState: string;
  /** A visible loading indicator (aria-busy / indeterminate progress / "Loading…"). */
  busy: boolean;
  /** false = the mutation tracker is gone → this is a new document. */
  tracked: boolean;
  mutAt: number;
  /** -1 = counter unavailable (tracker from an older build). */
  mutN: number;
}

/**
 * Self-contained injected probe (no closures over module scope) — see
 * `NavProbe`. Loading-text match is deliberately short-string-only so body
 * copy that merely mentions "loading" doesn't count.
 */
export function readNavProbe(): NavProbe {
  const w = window as unknown as { __pieMutAt?: number; __pieMutN?: number; __pieMutObs?: MutationObserver };
  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  };
  let busy = Array.from(
    document.querySelectorAll('[aria-busy="true"], [role="progressbar"]:not([aria-valuenow]), progress:not([value])'),
  ).some(visible);
  if (!busy && document.body) {
    const re = /^(loading|please wait|загрузка|завантаження|cargando|carregando|chargement|wird geladen|laden|caricamento|ładowanie|yükleniyor|読み込み中|ロード中|加载中|載入中|正在加载|로딩 중|불러오는 중)\s*(\.{1,3}|…)?$/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && !busy; n = walker.nextNode()) {
      const t = (n.nodeValue ?? "").trim();
      if (t.length > 0 && t.length <= 30 && re.test(t) && visible(n.parentElement)) busy = true;
    }
  }
  const h = document.querySelector("h1") ?? document.querySelector("h2");
  return {
    url: location.href,
    title: document.title,
    heading: (h?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    readyState: document.readyState,
    busy,
    tracked: !!w.__pieMutObs,
    mutAt: w.__pieMutAt ?? 0,
    mutN: w.__pieMutN ?? -1,
  };
}

/** Self-contained injected: drop every data-pie-idx stamp (shadow-inclusive). */
export function clearPieIdxInjected(): number {
  let n = 0;
  const walk = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.hasAttribute("data-pie-idx")) {
        el.removeAttribute("data-pie-idx");
        n++;
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return n;
}

const DEADLINE_TIMEOUT = Symbol("deadline-timeout");

/**
 * Resolve `promise` or return `DEADLINE_TIMEOUT` when `deadline` elapses.
 * A never-resolving `executeScript` must not outlive the shared nav budget
 * (#471 review: click/open_url hang when the probe never settles).
 */
function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T | typeof DEADLINE_TIMEOUT> {
  const remaining = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE_TIMEOUT), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function probeTopFrame(tabId: number, deadline?: number): Promise<NavProbe | null> {
  try {
    const exec = chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: readNavProbe,
      // Read mid-load state; the default (document_idle) would block here.
      injectImmediately: true,
    });
    const settled = deadline !== undefined ? await withDeadline(exec, deadline) : await exec;
    if (settled === DEADLINE_TIMEOUT) return null;
    const [r] = settled;
    const p = r?.result as NavProbe | undefined;
    return p && typeof p.url === "string" ? p : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort inject bounded by the shared settle deadline (never hangs past it).
 * Returns false on throw or deadline timeout.
 */
async function injectBounded(
  tabId: number,
  func: () => void,
  deadline?: number,
): Promise<boolean> {
  try {
    const exec = chrome.scripting.executeScript({
      target: { tabId },
      func,
      injectImmediately: true,
    });
    if (deadline !== undefined) {
      const settled = await withDeadline(exec, deadline);
      return settled !== DEADLINE_TIMEOUT;
    }
    await exec;
    return true;
  } catch {
    return false;
  }
}

// ponytail: plain "#section" anchors are in-page scrolls, not navigation;
// "#/route" / "#!route" fragments are hash-router navigations and count.
const routeUrl = (u: string): string => u.replace(/#(?![!/]).*$/, "");

/**
 * #471 — after navigation, every stamped idx and every page atlas of the tab
 * describes a page that no longer exists. Per-frame fan-out (never
 * allFrames:true — zombie frames, PR#264).
 */
export async function invalidatePageRefs(tabId: number, deadline?: number): Promise<void> {
  pageAtlasStore.invalidateTab(tabId);
  try {
    const remaining = deadline !== undefined ? Math.max(0, deadline - Date.now()) : undefined;
    await executeScriptAllFrames(
      tabId,
      clearPieIdxInjected,
      undefined,
      remaining !== undefined
        ? { topFrameTimeoutMs: remaining, subFrameTimeoutMs: remaining }
        : undefined,
    );
  } catch {
    // Tab gone / frames unreachable — nothing left to clear.
  }
}

/**
 * Poll the top frame until the document is parsed, the DOM has been quiet
 * for `quietMs`, and no loading indicator is visible — or `deadline` passes.
 * Used by open_url (#471) so the next read_page doesn't see a skeleton.
 */
export async function waitForPageLoad(
  tabId: number,
  deadline: number,
  { quietMs = 500, pollMs = 200 }: { quietMs?: number; pollMs?: number } = {},
): Promise<"loaded" | "loading" | "unavailable"> {
  const startedAt = Date.now();
  let seen = false; // ponytail: a failed FIRST probe = unprobeable page, skip the wait
  while (Date.now() < deadline) {
    const p = await probeTopFrame(tabId, deadline);
    if (p) {
      seen = true;
      if (!p.tracked) {
        await injectBounded(tabId, installMutationTracker, deadline);
      } else if (
        p.readyState !== "loading"
        && !p.busy
        && Date.now() - Math.max(p.mutAt, startedAt) >= quietMs
      ) {
        return "loaded";
      }
    } else if (!seen) {
      // Timed out or threw on the first probe. If the deadline is already
      // gone, treat as still loading (hanging inject); otherwise the page
      // is unprobeable (restricted / blocked) — don't burn the budget.
      if (Date.now() >= deadline) return "loading";
      return "unavailable";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((r) => setTimeout(r, Math.min(pollMs, remaining)));
  }
  return seen ? "loading" : "unavailable";
}

/**
 * #251 — build the observation suffix appended when an action opened one or
 * more new tabs (target=_blank / window.open fanout). Only browser-derived
 * tab ids (numbers) and origins parsed via `new URL().origin` make it into
 * the text — NEVER the page-controlled tab title, which is an injection
 * surface. The suffix points the model at `switch_to_new_tab`, the
 * recovery tool that adopts + focuses a tab the session spawned.
 */
function formatNewTabNotice(
  ids: number[],
  origins: Map<number, string>,
): string {
  const label = (id: number) => {
    const origin = origins.get(id);
    return origin ? `${id}, ${origin}` : `${id}`;
  };
  if (ids.length === 1) {
    return `This action opened a new tab (id ${label(ids[0])}). If the task continues there, call switch_to_new_tab to adopt and focus it.`;
  }
  const list = ids.map(label).join("; ");
  return `This action opened ${ids.length} new tabs (${list}). If the task continues in one of them, call switch_to_new_tab to adopt and focus it.`;
}

export interface ActionSettleOptions {
  /**
   * Quiet window required to declare the page settled. After the action
   * returns, the wait loop continues until `now - lastActivityAt >= quietMs`.
   * Default 500ms — empirically large enough to bridge a typical Turbo
   * fetch round-trip on a normal connection without making non-mutating
   * clicks (dropdown open, input focus) feel sluggish. Slow networks may
   * still race; the trade-off is documented in #27.
   */
  quietMs?: number;
  /**
   * Hard cap on total wait, ms. Default 3000. Prevents wedging on pages
   * with continuous DOM mutations (live charts, animated banners) where
   * the quiet condition would never be met.
   */
  maxMs?: number;
  /**
   * Polling interval for the page-side mutation timestamp + the quiet
   * check, ms. Default 100. Lower = sooner exit on settle, more
   * executeScript IPC calls; 100ms is a reasonable balance.
   */
  pollMs?: number;
  /**
   * #471 — click: detect a navigation the action started (top-frame
   * webNavigation event / fingerprint change / document teardown within
   * `navObserveMs`) and wait for the new page to load (≤ `navMaxMs`).
   * Unprobeable pages (restricted / injection blocked) fall back to the
   * plain quiet settle.
   */
  detectNavigation?: boolean;
  /** Append "no change detected" when nothing happened. Default true. */
  reportNoChange?: boolean;
  navObserveMs?: number;
  navMaxMs?: number;
  /**
   * After the URL has actually changed, how long to wait for title/heading
   * to follow before accepting a URL-only settle. Does NOT apply to a bare
   * onBeforeNavigate while the old document is still unchanged.
   */
  urlOnlyGraceMs?: number;
  navPollMs?: number;
}

const appendNote = (r: ActionResult, note: string): void => {
  r.observation = r.observation ? `${r.observation} ${note}` : note;
};

/**
 * Run an action that may mutate the page, then wait for any consequences
 * to settle before returning the action's result. See module-level JSDoc
 * for the design rationale and signal taxonomy.
 *
 * `performAction` is invoked AFTER the mutation tracker is installed and
 * the webNavigation listeners are attached, so synchronous DOM mutations
 * inside the action's click handler are captured. Failures from
 * `performAction` short-circuit the wait — the result is returned
 * immediately without any settle delay.
 */
export async function withActionSettle<T extends ActionResult>(
  tabId: number,
  performAction: () => Promise<T>,
  options: ActionSettleOptions = {},
): Promise<T> {
  const {
    quietMs = 500,
    maxMs = 3000,
    pollMs = 100,
    detectNavigation = false,
    reportNoChange = true,
    navObserveMs = 1000,
    navMaxMs = 10_000,
    urlOnlyGraceMs = 1500,
    navPollMs = 200,
  } = options;

  // Install the mutation tracker BEFORE the action so a synchronous DOM
  // mutation during the action's click handler is captured. Best-effort
  // — injection can fail on restricted pages, mid-navigation tear-down,
  // or detached tabs; in those cases we fall back to webNavigation-only
  // observation, which still covers cross-doc nav and SPA pushState.
  //
  // #471 review round 2 — detectNavigation prep (install + fingerprint)
  // shares a prep deadline of navObserveMs so a hung executeScript cannot
  // block the action forever. Timeout → quiet-only fallback (pre = null).
  let trackerInstalled = false;
  let pre: NavProbe | null = null;
  if (detectNavigation) {
    const prepDeadline = Date.now() + navObserveMs;
    trackerInstalled = await injectBounded(tabId, installMutationTracker, prepDeadline);
    if (trackerInstalled) {
      pre = await probeTopFrame(tabId, prepDeadline);
    }
  } else {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: installMutationTracker,
      });
      trackerInstalled = true;
    } catch {
      trackerInstalled = false;
    }
  }

  let lastSignalAt = 0;
  let navSignalAt = 0;
  const onNavEvent = (details: { tabId: number; frameId: number }) => {
    // frameId 0 = top frame; sub-frame nav doesn't change the agent's
    // observation target so we ignore it.
    if (details.tabId !== tabId || details.frameId !== 0) return;
    lastSignalAt = Date.now();
    if (!navSignalAt) navSignalAt = lastSignalAt;
  };
  chrome.webNavigation.onCommitted.addListener(onNavEvent);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onNavEvent);
  if (pre) chrome.webNavigation.onBeforeNavigate.addListener(onNavEvent);

  // #251 — detect fanout: a click / keypress that opens a new tab via
  // target=_blank or window.open. The settle signals above are all scoped to
  // the acting tab, so the model would otherwise never learn a new tab exists
  // and stall on the original page. Collect tabs whose `openerTabId` is the
  // acting tab; on a successful action their ids (+ parsed origins, never the
  // page-controlled title) are appended to the observation.
  const newTabIds: number[] = [];
  const newTabOrigins = new Map<number, string>();
  const onTabCreated = (tab: chrome.tabs.Tab) => {
    if (tab.id === undefined || tab.openerTabId !== tabId) return;
    if (newTabIds.includes(tab.id)) return;
    newTabIds.push(tab.id);
    // At onCreated time the tab may still be about:blank with the real
    // destination in `pendingUrl`; prefer whichever parses to a concrete
    // origin. Unparseable / opaque ("null") origins are simply omitted.
    const rawUrl = tab.pendingUrl || tab.url || "";
    if (rawUrl) {
      try {
        const origin = new URL(rawUrl).origin;
        if (origin && origin !== "null") newTabOrigins.set(tab.id, origin);
      } catch {
        // unparseable URL — id-only notice
      }
    }
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  try {
    const result = await performAction();
    if (!result.success) return result;

    const performedAt = Date.now();
    // Compatible post-action budgets (#471 review round 2):
    //   observeDeadline = performedAt + navObserveMs
    //   quietDeadline   = performedAt + maxMs   (plain quiet + final no-change probe)
    //   navDeadline     = performedAt + navMaxMs (phase-2 nav wait + ref clear)
    const quietDeadline = performedAt + maxMs;

    // Quiet settle. `lastActivityAt` is the maximum of three timestamps:
    //   - performedAt: floor so we always wait at least quietMs after the
    //     action returns (lets sync DOM mutations during the click
    //     handler clear the quiet check).
    //   - lastSignalAt: bumped by webNavigation events.
    //   - pageMutAt: bumped by the page-side MutationObserver via the
    //     latest poll.
    // Every inject is capped by `deadline` so observe-timeout cannot fall
    // into an unbounded quiet wait.
    const quietSettle = async (deadline: number): Promise<void> => {
      while (Date.now() < deadline) {
        const remain = deadline - Date.now();
        if (remain <= 0) break;
        await sleep(Math.min(pollMs, remain));
        const now = Date.now();

        let pageMutAt = 0;
        if (trackerInstalled) {
          try {
            const exec = chrome.scripting.executeScript({
              target: { tabId },
              func: readMutationTimestamp,
            });
            const settled = await withDeadline(exec, deadline);
            if (settled === DEADLINE_TIMEOUT) break;
            pageMutAt = (settled[0]?.result as number) ?? 0;
          } catch {
            // Cross-doc tear-down in progress — the script context is
            // gone. Treat that itself as a signal (extend the wait by one
            // quiet window) and try to re-install the tracker on the new
            // doc once it's available. Re-install is fire-and-forget so
            // the loop body stays prompt; if the new doc rejects it
            // (chrome:// landing page, etc.) we continue with
            // webNavigation-only observation.
            trackerInstalled = false;
            lastSignalAt = now;
            void injectBounded(tabId, installMutationTracker, deadline).then((ok) => {
              if (ok) trackerInstalled = true;
            });
          }
        }

        const lastActivityAt = Math.max(lastSignalAt, pageMutAt, performedAt);
        if (now - lastActivityAt >= quietMs) break;
        if (now - performedAt >= maxMs) break;
      }
    };

    if (!pre) {
      await quietSettle(quietDeadline);
    } else {
      // ── #471 phase 1: did the action start a navigation? ──
      let navStartAt = 0;
      let last: NavProbe = pre;
      let newDoc = false;
      const observeDeadline = performedAt + navObserveMs;
      while (!navStartAt && Date.now() < observeDeadline) {
        const remainObs = observeDeadline - Date.now();
        if (remainObs <= 0) break;
        await sleep(Math.min(navPollMs, remainObs));
        if (navSignalAt) {
          navStartAt = navSignalAt;
          break;
        }
        const p = await probeTopFrame(tabId, observeDeadline);
        if (!p || !p.tracked) {
          // Old document torn down (or replaced) — cross-document navigation.
          // A deadline-timed-out probe (null, old doc still there) is NOT
          // teardown — only treat as newDoc when we got an untracked probe
          // or the inject threw mid-teardown (null after we already had pre).
          // Distinguishing: null with time left ≈ throw/teardown; null at
          // observeDeadline ≈ hung inject (don't invent a navigation).
          if (!p && Date.now() >= observeDeadline) break;
          newDoc = true;
          navStartAt = Date.now();
          if (p) last = p;
        } else {
          last = p;
          if (routeUrl(p.url) !== routeUrl(pre.url) || p.title !== pre.title || p.heading !== pre.heading) {
            navStartAt = Date.now();
          }
        }
      }
      if (!navStartAt && navSignalAt) navStartAt = navSignalAt;

      if (!navStartAt) {
        // Plain button / toggle click — quiet settle bounded by maxMs.
        // Final no-change probe shares the same quietDeadline; timeout
        // skips the note and returns (must not hang the ordinary click).
        await quietSettle(quietDeadline);
        if (reportNoChange && pre.mutN >= 0 && !navSignalAt) {
          const after = await probeTopFrame(tabId, quietDeadline);
          if (after && after.tracked && after.mutN === pre.mutN) {
            appendNote(result, "No navigation or page change detected — the page may be unchanged (form-control state such as a checkbox is not tracked). Call read_page to check before retrying.");
          }
        }
      } else {
        // ── phase 2: wait for the new page to be ready ──
        const deadline = performedAt + navMaxMs;
        let urlChangedAt = 0;
        let loaded = false;
        while (Date.now() < deadline) {
          const remain = deadline - Date.now();
          if (remain <= 0) break;
          await sleep(Math.min(navPollMs, remain));
          const p = await probeTopFrame(tabId, deadline);
          if (!p) {
            // Mid-teardown / new doc not injectable yet — or probe hit the
            // deadline. Only extend the wait when budget remains.
            if (Date.now() >= deadline) break;
            newDoc = true;
            lastSignalAt = Date.now();
            continue;
          }
          last = p;
          if (!p.tracked) {
            newDoc = true;
            lastSignalAt = Date.now();
            await injectBounded(tabId, installMutationTracker, deadline);
            continue;
          }
          const now = Date.now();
          if (!urlChangedAt && routeUrl(p.url) !== routeUrl(pre.url)) urlChangedAt = now;
          const contentChanged = newDoc || p.title !== pre.title || p.heading !== pre.heading;
          // URL-only grace starts ONLY after the URL actually changed — a
          // lone onBeforeNavigate while the old document is still complete
          // must keep waiting for commit or the nav budget (#471 review).
          const graceOver = urlChangedAt > 0 && now - urlChangedAt >= urlOnlyGraceMs;
          const quiet = now - Math.max(lastSignalAt, p.mutAt, navStartAt) >= quietMs;
          if (p.readyState !== "loading" && quiet && !p.busy && (contentChanged || graceOver)) {
            loaded = true;
            break;
          }
        }

        const navigated = newDoc || urlChangedAt > 0 || last.title !== pre.title || last.heading !== pre.heading;
        if (navigated) {
          await invalidatePageRefs(tabId, deadline);
          let url = last.url;
          if (last === pre) {
            url = (await chrome.tabs.get(tabId).catch(() => undefined))?.url ?? "an unknown URL";
          }
          appendNote(
            result,
            loaded
              ? `The page navigated. Now at ${url}. Element indices from earlier read_page calls are no longer valid — call read_page before interacting.`
              : `The page navigated (now at ${url}) but was still loading after ${Math.round(navMaxMs / 1000)}s; read_page may see partial content. Element indices from earlier read_page calls are no longer valid.`,
          );
        } else {
          appendNote(
            result,
            loaded
              ? "A navigation was signalled but no page change was detected — the page may be unchanged."
              : `A navigation was signalled but the page had not changed after ${Math.round(navMaxMs / 1000)}s (still loading?).`,
          );
        }
      }
    }

    if (newTabIds.length > 0) appendNote(result, formatNewTabNotice(newTabIds, newTabOrigins));

    return result;
  } finally {
    chrome.webNavigation.onCommitted.removeListener(onNavEvent);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onNavEvent);
    if (pre) chrome.webNavigation.onBeforeNavigate.removeListener(onNavEvent);
    chrome.tabs.onCreated.removeListener(onTabCreated);
  }
}
