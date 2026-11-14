// src/lib/monitors/extract.ts
//
// Value extraction for page monitors (§4.3 step 1/2). Two modes:
//   direct — SW fetch (no user tab, no JS) → offscreen DOMParser → extractFromDoc
//   tab    — hidden background tab + executeScript → extractInPage
//
// §4.2 / S7 实测项「SW fetch 带不带 SameSite 登录 cookie」：fetch 用
// credentials:"include"，Chrome 会把 SameSite=None/Lax 的 cookie 照常带上（同站
// 请求），但 SameSite=Strict 或 Cloudflare 一类风控页仍会看到未登录。代码不假设
// 结果：direct 返回 login/blocked 或定位失败时，调用方按「带不上就走 tab」升级
// （check.ts 的 fetchMode 升级）。真机验证步骤见交付报告的真机清单。

import { sendToOffscreen } from "@/background/offscreen-manager";
import { extractInPage, type ExtractResult, type ExtractVia } from "./html-extract";
import type { MonitorTarget } from "./types";

export type CheckFailureReason = "login" | "blocked" | "not_found" | "network";

/** Hard ceiling on a direct fetch so one dead host can't stall the origin chain. */
export const FETCH_TIMEOUT_MS = 20_000;

export type ExtractOutcome =
  | { ok: true; value: string; via: ExtractVia; fetchMode: "direct" | "tab" }
  | { ok: false; reason: CheckFailureReason; detail: string };

// ── Failure classification (pure, testable) ──────────────────────────────────

const LOGIN_URL_RE = /(?:^|[/._-])(?:login|log-in|signin|sign-in|sign_in|auth|passport|sso|account\/login)(?:[/._?=-]|$)/i;

/** A redirect to a login-ish URL, or an unauthenticated status, means "login". */
export function looksLikeLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOGIN_URL_RE.test(u.pathname) || LOGIN_URL_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** Classify a non-2xx fetch or a suspicious final URL. */
export function classifyHttpFailure(status: number, finalUrl: string, requestedUrl: string): CheckFailureReason | null {
  if (status === 401 || status === 403) return "login";
  if (status === 429) return "blocked";
  if (status >= 500) return "network";
  // A redirect that lands on a login page (and isn't where we started) is the
  // classic "session expired" shape.
  if (finalUrl !== requestedUrl && looksLikeLoginUrl(finalUrl)) return "login";
  return null;
}

/** Verification-page heuristic for 200 responses (Cloudflare / captcha walls). */
export function looksLikeBlockedPage(html: string): boolean {
  const head = html.slice(0, 20_000).toLowerCase();
  return (
    head.includes("cf-challenge") ||
    head.includes("checking your browser") ||
    head.includes("just a moment") ||
    head.includes("captcha") ||
    head.includes("access denied")
  );
}

// ── direct ───────────────────────────────────────────────────────────────────

export interface FetchDeps {
  fetchImpl: typeof fetch;
  extract: (html: string, target: MonitorTarget) => Promise<ExtractResult>;
}

const defaultFetchDeps: FetchDeps = {
  fetchImpl: (input, init) => fetch(input, init),
  extract: async (html, target) =>
    sendToOffscreen<ExtractResult>({
      type: "monitor:extract",
      html,
      selector: target.selector,
      ...(target.anchorText ? { anchorText: target.anchorText } : {}),
      sample: target.sample,
    }),
};

export async function extractDirect(
  url: string,
  target: MonitorTarget,
  deps: FetchDeps = defaultFetchDeps,
): Promise<ExtractOutcome> {
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      // A hung fetch would block this origin's serialized chain forever.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: "network", detail: e instanceof Error ? e.message : String(e) };
  }

  const finalUrl = res.url || url;
  const failure = classifyHttpFailure(res.status, finalUrl, url);
  if (failure) return { ok: false, reason: failure, detail: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}` };

  let html: string;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, reason: "network", detail: e instanceof Error ? e.message : String(e) };
  }

  let extracted: ExtractResult;
  try {
    extracted = await deps.extract(html, target);
  } catch (e) {
    return { ok: false, reason: "network", detail: e instanceof Error ? e.message : String(e) };
  }
  if (extracted.found) {
    return { ok: true, value: extracted.text, via: extracted.via ?? "selector", fetchMode: "direct" };
  }

  // Only classify the failure once extraction failed — a legit page that merely
  // mentions "captcha" must not be treated as a bot wall.
  if (looksLikeBlockedPage(html)) return { ok: false, reason: "blocked", detail: "verification page" };
  return { ok: false, reason: "not_found", detail: "target not in fetched HTML" };
}

// ── tab fallback ─────────────────────────────────────────────────────────────

/** Poll until the tab reports complete (or the timeout expires). */
async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {
      return false; // tab gone
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Grace period after `complete` so client-side rendering can finish. */
const RENDER_SETTLE_MS = 800;

export interface TabCheckHooks {
  /** Called with the created tab id so the caller can clean it up on SW death. */
  onTabOpen?: (tabId: number) => Promise<void> | void;
  /** Called after the tab was closed (clears the persisted activeTabId). */
  onTabClose?: () => Promise<void> | void;
  waitForComplete?: (tabId: number) => Promise<boolean>;
  settleMs?: number;
}

export async function extractViaTab(
  url: string,
  target: MonitorTarget,
  hooks: TabCheckHooks = {},
): Promise<ExtractOutcome & { tabId?: number }> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) return { ok: false, reason: "network", detail: "tab created without id" };
    tabId = tab.id;
    await hooks.onTabOpen?.(tabId);

    const loaded = await (hooks.waitForComplete ?? ((id: number) => waitForTabComplete(id, 20_000)))(tabId);
    if (!loaded) return { ok: false, reason: "network", detail: "tab did not finish loading" };
    await new Promise((r) => setTimeout(r, hooks.settleMs ?? RENDER_SETTLE_MS));

    let results: chrome.scripting.InjectionResult<ExtractResult>[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractInPage,
        args: [
          {
            selector: target.selector,
            ...(target.anchorText ? { anchorText: target.anchorText } : {}),
            ...(target.sample ? { sample: target.sample } : {}),
          },
        ],
        injectImmediately: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Chrome refuses injection on the Web Store and other protected pages.
      const reason: CheckFailureReason = /cannot be scripted|Cannot access|chrome:\/\/|extensions gallery/i.test(msg)
        ? "blocked"
        : "network";
      return { ok: false, reason, detail: msg, tabId };
    }

    const extracted = results?.[0]?.result as ExtractResult | undefined;
    if (!extracted || !extracted.found) {
      return { ok: false, reason: "not_found", detail: "target not in rendered DOM", tabId };
    }
    return { ok: true, value: extracted.text, via: extracted.via ?? "selector", fetchMode: "tab", tabId };
  } catch (e) {
    return { ok: false, reason: "network", detail: e instanceof Error ? e.message : String(e), tabId };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* tab already gone */
      }
      await hooks.onTabClose?.();
    }
  }
}
