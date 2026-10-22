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
 */

import type { ActionResult } from "../dom-actions/types";

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
  const obs = new MutationObserver(() => {
    (window as unknown as W).__pieMutAt = Date.now();
  });
  // `document.body` is null very early in load (before <body> parsed);
  // fall back to `document` so we still register top-level changes.
  obs.observe(document.body ?? document, {
    childList: true,
    subtree: true,
  });
  w.__pieMutObs = obs;
}

function readMutationTimestamp(): number {
  return (window as unknown as { __pieMutAt?: number }).__pieMutAt ?? 0;
}

/** What `probeNavState` reports about the top document. */
export interface NavProbe {
  url: string;
  title: string;
  /** Text of the page's main heading (first h1, else first h2), trimmed. */
  heading: string;
  readyState: DocumentReadyState;
  /** Last DOM mutation seen by the tracker (ms epoch); install time if none. */
  mutAt: number;
  /** A visible loading indicator is on screen (spinner / "Loading…"). */
  loading: boolean;
}

/**
 * Self-contained injected probe: URL + DOM fingerprint (title, main heading),
 * readiness, last mutation time and whether a loading indicator is visible.
 * Installs the mutation tracker itself when missing (a new document after a
 * cross-doc navigation has none yet) — the install time counts as activity,
 * so a freshly loaded page still has to stay quiet for one window.
 *
 * MUST be self-contained for `chrome.scripting.executeScript`.
 */
export function probeNavState(): NavProbe {
  type W = { __pieMutAt?: number; __pieMutObs?: MutationObserver };
  const w = window as unknown as W;
  if (!w.__pieMutObs) {
    w.__pieMutAt = Date.now();
    const obs = new MutationObserver(() => {
      (window as unknown as W).__pieMutAt = Date.now();
    });
    obs.observe(document.body ?? document, { childList: true, subtree: true });
    w.__pieMutObs = obs;
  }

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") !== 0;
  };

  let heading = "";
  for (const sel of ["main h1", "[role='main'] h1", "h1", "[role='heading'][aria-level='1']", "main h2", "h2"]) {
    const el = document.querySelector(sel);
    const text = (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      heading = text.slice(0, 200);
      break;
    }
  }

  // Loading indicators: busy regions, indeterminate progress bars (no
  // aria-valuenow — a determinate bar such as course progress is not a
  // spinner), and short visible "Loading…" labels in common UI languages.
  const LOADING_RE =
    /^(loading|загрузка|завантаження|cargando|carregando|chargement|wird geladen|caricamento|ładowanie|読み込み中|加载中|載入中|正在加载|로딩 중)(\s*(\.{1,3}|…))?$/i;
  let loading = false;
  for (const el of Array.from(
    document.querySelectorAll("[aria-busy='true'], [role='progressbar']:not([aria-valuenow])"),
  ).slice(0, 200)) {
    if (visible(el)) {
      loading = true;
      break;
    }
  }
  if (!loading) {
    for (const el of Array.from(document.querySelectorAll("[aria-label]")).slice(0, 2000)) {
      const label = (el.getAttribute("aria-label") ?? "").trim();
      if (label.length <= 30 && LOADING_RE.test(label) && visible(el)) {
        loading = true;
        break;
      }
    }
  }
  if (!loading && document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node && seen < 5000; node = walker.nextNode()) {
      seen++;
      const text = (node.nodeValue ?? "").trim();
      if (text && text.length <= 30 && LOADING_RE.test(text) && node.parentElement && visible(node.parentElement)) {
        loading = true;
        break;
      }
    }
  }

  return {
    url: location.href,
    title: document.title,
    heading,
    readyState: document.readyState,
    mutAt: w.__pieMutAt ?? 0,
    loading,
  };
}

/**
 * Self-contained injected helper: drop every data-pie-idx stamp in this frame.
 * Run after a navigation so element indices from an earlier read_page fail
 * fast ("Element not found … call read_page again") instead of resolving to
 * a node an SPA re-used for something else.
 */
export function clearPieIndices(): number {
  const els = document.querySelectorAll("[data-pie-idx]");
  els.forEach((el) => el.removeAttribute("data-pie-idx"));
  return els.length;
}

/** URL, title or main heading differ → the page is not the one we started on. */
export function pageChanged(before: NavProbe, after: NavProbe): boolean {
  return before.url !== after.url || before.title !== after.title || before.heading !== after.heading;
}

async function runProbe(tabId: number): Promise<NavProbe | null> {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: probeNavState });
    return (results[0]?.result as NavProbe | undefined) ?? null;
  } catch {
    return null; // document tearing down / restricted page
  }
}

/** Strip data-pie-idx in every frame of the tab. Best-effort. */
export async function invalidateElementIndices(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: clearPieIndices });
  } catch {
    // tab gone / restricted — nothing to invalidate
  }
}

const shortUrl = (url: string) => (url.length > 300 ? `${url.slice(0, 300)}…` : url);

export interface PageReadyOptions {
  /** Required quiet window (no DOM mutations), ms. Default 500. */
  quietMs?: number;
  /** Give up at this absolute time (ms epoch). */
  deadline: number;
  /** Poll interval, ms. Default 200. */
  pollMs?: number;
}

export type PageReadyResult =
  | { ready: true; probe: NavProbe }
  | { ready: false; probe: NavProbe | null; reason: "loading" | "busy" | "unreachable" };

/**
 * Wait until the tab's document has parsed, the DOM has been quiet for
 * `quietMs` and no loading indicator is visible — or the deadline passes.
 */
export async function waitForPageReady(tabId: number, opts: PageReadyOptions): Promise<PageReadyResult> {
  const quietMs = opts.quietMs ?? 500;
  const pollMs = opts.pollMs ?? 200;
  let last: NavProbe | null = null;
  let failures = 0;
  for (;;) {
    const p = await runProbe(tabId);
    if (p) last = p;
    failures = p ? 0 : failures + 1;
    const now = Date.now();
    // Never reachable (restricted page, injection blocked): nothing to wait for.
    if (!last && failures >= 5) return { ready: false, probe: null, reason: "unreachable" };
    if (p && p.readyState !== "loading" && now - p.mutAt >= quietMs && !p.loading) {
      return { ready: true, probe: p };
    }
    if (now >= opts.deadline) {
      return {
        ready: false,
        probe: last,
        reason: !last ? "unreachable" : last.loading || last.readyState === "loading" ? "loading" : "busy",
      };
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
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
   * Navigation-aware mode (click). Fingerprints the page (URL, title, main
   * heading) before the action. If the URL / fingerprint starts changing —
   * or a navigation event fires — within `navStartMs`, waits (up to
   * `navTimeoutMs`) until the page has actually changed, the DOM has been
   * quiet for `quietMs` and no loading spinner is visible; then invalidates
   * element indices. Otherwise it is a non-navigating click (button,
   * toggle) and only the normal quiet settle applies. The observation says
   * what happened, including "navigation not detected".
   */
  detectNavigation?: boolean;
  /** How long to watch for a navigation to START. Default 1000. */
  navStartMs?: number;
  /** Max wait for a started navigation to land and settle. Default 10000. */
  navTimeoutMs?: number;
  /**
   * SPAs often push the new URL first and swap the content in after a fetch.
   * When only the URL changed, give the title / main heading this long to
   * follow before settling on DOM quiet alone. Default 1500.
   */
  urlOnlyGraceMs?: number;
  /** Called once a navigation changed the page (after indices are cleared). */
  onNavigated?: (tabId: number) => void;
}

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
  const { quietMs = 500, maxMs = 3000, pollMs = 100 } = options;
  if (options.detectNavigation) return withNavigationSettle(tabId, performAction, options);

  // Install the mutation tracker BEFORE the action so a synchronous DOM
  // mutation during the action's click handler is captured. Best-effort
  // — injection can fail on restricted pages, mid-navigation tear-down,
  // or detached tabs; in those cases we fall back to webNavigation-only
  // observation, which still covers cross-doc nav and SPA pushState.
  let trackerInstalled = false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: installMutationTracker,
    });
    trackerInstalled = true;
  } catch {
    trackerInstalled = false;
  }

  let lastSignalAt = 0;
  const onNavEvent = (details: { tabId: number; frameId: number }) => {
    // frameId 0 = top frame; sub-frame nav doesn't change the agent's
    // observation target so we ignore it.
    if (details.tabId !== tabId || details.frameId !== 0) return;
    lastSignalAt = Date.now();
  };
  chrome.webNavigation.onCommitted.addListener(onNavEvent);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onNavEvent);

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

  try {
    const result = await performAction();
    if (!result.success) return result;

    const performedAt = Date.now();

    // Settle loop. `lastActivityAt` is the maximum of three timestamps:
    //   - performedAt: floor so we always wait at least quietMs after the
    //     action returns (lets sync DOM mutations during the click
    //     handler clear the quiet check).
    //   - lastSignalAt: bumped by webNavigation events.
    //   - pageMutAt: bumped by the page-side MutationObserver via the
    //     latest poll.
    while (true) {
      await new Promise<void>((r) => setTimeout(r, pollMs));
      const now = Date.now();

      let pageMutAt = 0;
      if (trackerInstalled) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: readMutationTimestamp,
          });
          pageMutAt = (results[0]?.result as number) ?? 0;
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
          chrome.scripting
            .executeScript({
              target: { tabId },
              func: installMutationTracker,
            })
            .then(() => {
              trackerInstalled = true;
            })
            .catch(() => {
              // best-effort; the new doc may be inaccessible
            });
        }
      }

      const lastActivityAt = Math.max(lastSignalAt, pageMutAt, performedAt);
      const sinceLastActivity = now - lastActivityAt;
      const elapsed = now - performedAt;

      if (sinceLastActivity >= quietMs) break;
      if (elapsed >= maxMs) break;
    }

    if (newTabIds.length > 0) {
      const notice = formatNewTabNotice(newTabIds, newTabOrigins);
      result.observation = result.observation
        ? `${result.observation} ${notice}`
        : notice;
    }

    return result;
  } finally {
    chrome.webNavigation.onCommitted.removeListener(onNavEvent);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onNavEvent);
    chrome.tabs.onCreated.removeListener(onTabCreated);
  }
}

/**
 * `withActionSettle({detectNavigation: true})`. See ActionSettleOptions.
 * Phases, polled every ~200ms from the moment the action returned:
 *   1. watch for a navigation to start (≤ navStartMs): a top-frame
 *      webNavigation event, the URL / title / main heading differing from the
 *      pre-action fingerprint, or the document tearing down;
 *   2a. none → ordinary click: wait for one quiet window (≤ maxMs);
 *   2b. started → wait (≤ navTimeoutMs) until the page changed, parsed, went
 *       quiet and shows no spinner. Element indices are then invalidated.
 */
async function withNavigationSettle<T extends ActionResult>(
  tabId: number,
  performAction: () => Promise<T>,
  options: ActionSettleOptions,
): Promise<T> {
  const { quietMs = 500, maxMs = 3000, navStartMs = 1000, navTimeoutMs = 10_000, urlOnlyGraceMs = 1500 } = options;
  const pollMs = options.pollMs ?? 200;

  const before = await runProbe(tabId); // also installs the mutation tracker
  // Can't inspect this page at all (restricted / injection blocked): a failed
  // probe later would prove nothing, so use the plain settle.
  if (!before) return withActionSettle(tabId, performAction, { ...options, detectNavigation: false });

  let navSignalAt = 0;
  const onNavEvent = (details: { tabId: number; frameId: number }) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    navSignalAt = Date.now();
  };
  chrome.webNavigation.onBeforeNavigate.addListener(onNavEvent);
  chrome.webNavigation.onCommitted.addListener(onNavEvent);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onNavEvent);

  const newTabIds: number[] = [];
  const newTabOrigins = new Map<number, string>();
  const onTabCreated = (tab: chrome.tabs.Tab) => {
    if (tab.id === undefined || tab.openerTabId !== tabId || newTabIds.includes(tab.id)) return;
    newTabIds.push(tab.id);
    try {
      const origin = new URL(tab.pendingUrl || tab.url || "").origin;
      if (origin && origin !== "null") newTabOrigins.set(tab.id, origin);
    } catch {
      // id-only notice
    }
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  const appendNote = (r: T, note: string) => {
    r.observation = r.observation ? `${r.observation} ${note}` : note;
  };

  try {
    const actionStartedAt = Date.now();
    const result = await performAction();
    if (!result.success) return result;
    const t0 = Date.now();

    let navStarted = false;
    let navAt = 0;
    let changed = false;
    let contentChanged = false; // title or main heading, not just the URL
    let last: NavProbe | null = null;
    let outcome: "no-nav" | "settled" | "timeout" = "timeout";

    for (;;) {
      await new Promise<void>((r) => setTimeout(r, pollMs));
      const p = await runProbe(tabId);
      const now = Date.now();
      if (p) last = p;

      if (!p && !navStarted) {
        navStarted = true; // document tore down → cross-document navigation
        navAt = now;
      }
      if (navSignalAt >= actionStartedAt && !navStarted) {
        navStarted = true;
        navAt = navSignalAt;
      }
      if (p && (p.title !== before.title || p.heading !== before.heading)) contentChanged = true;
      if (p && pageChanged(before, p)) {
        changed = true;
        if (!navStarted) {
          navStarted = true;
          navAt = now;
        }
      }
      const elapsed = now - t0;

      if (!navStarted) {
        // Ordinary click unless a navigation starts within navStartMs.
        const quiet = !p || now - Math.max(p.mutAt, t0) >= quietMs;
        if (elapsed >= navStartMs && (quiet || elapsed >= maxMs)) {
          outcome = "no-nav";
          break;
        }
        continue;
      }

      if (elapsed >= navTimeoutMs) break;
      if (!p || p.readyState === "loading") continue;
      // Settle once the content (title / heading) changed. A URL-only change
      // gets urlOnlyGraceMs for the content to follow; a navigation event with
      // no visible change at all (same-URL reload) gets 2s.
      const sinceNav = now - navAt;
      const changeOk = contentChanged || (changed && sinceNav >= urlOnlyGraceMs) || sinceNav >= 2000;
      const quiet = now - Math.max(p.mutAt, navSignalAt, navAt) >= quietMs;
      if (changeOk && quiet && !p.loading) {
        outcome = "settled";
        break;
      }
    }

    if (outcome === "no-nav") {
      const domTouched = last ? last.mutAt >= actionStartedAt : true;
      if (!domTouched) {
        appendNote(result, "No navigation or page change detected — the page may be unchanged.");
      }
    } else {
      if (changed) {
        await invalidateElementIndices(tabId);
        options.onNavigated?.(tabId);
      }
      const at = last ? ` Now at ${shortUrl(last.url)}.` : "";
      if (outcome === "settled") {
        appendNote(
          result,
          `The page navigated.${at} Element indices from earlier read_page calls are no longer valid — call read_page before the next click or type.`,
        );
      } else if (!changed) {
        appendNote(
          result,
          `Navigation not detected: a navigation started but the URL, title and main heading did not change within ${Math.round(navTimeoutMs / 1000)}s — the page may be unchanged.`,
        );
      } else {
        appendNote(
          result,
          `The page navigated but was still loading after ${Math.round(navTimeoutMs / 1000)}s.${at} read_page may show a partial page; element indices from earlier read_page calls are no longer valid.`,
        );
      }
    }

    if (newTabIds.length > 0) appendNote(result, formatNewTabNotice(newTabIds, newTabOrigins));
    return result;
  } finally {
    chrome.webNavigation.onBeforeNavigate.removeListener(onNavEvent);
    chrome.webNavigation.onCommitted.removeListener(onNavEvent);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onNavEvent);
    chrome.tabs.onCreated.removeListener(onTabCreated);
  }
}
