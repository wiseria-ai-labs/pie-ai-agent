// Overlay orchestration in the service worker.
//
// Three jobs, all of which must survive the page going away:
//
//   1. Entry points — hotkey, selection-bar intent, omnibox, toolbar icon —
//      resolve a session for the tab and tell the content script to open the
//      overlay document (or fall back to the side panel on restricted pages).
//   2. Task mirror — an overlay task's port lives in the page, so a navigation
//      kills it. The run mirror below keeps the task alive through that (no
//      abort), feeds the in-page capsule, and persists the messages the dead
//      document would have persisted.
//   3. Surface guard — screenshots and page-occluding writes must not see
//      Pie's own overlay/capsule, so they hide it around the operation.
//
// The overlay document itself is an ordinary panel client: it owns a
// chat-stream port and talks to this module only for open state and page-side
// actions (write-back, handoff, close).

import { createSession, getSessionMeta, persistSessionMessages } from "@/lib/sessions/storage";
import type { DisplayMessage, PortMessageToPanel } from "@/types";
import { isRestrictedUrl } from "@/lib/url/restricted";
import { isPdfTab } from "@/lib/pdf/detect";
import { canHostOverlay } from "@/lib/overlay/eligibility";
import { queryActiveHostTab } from "@/lib/panel-host/host-window";
import {
  CAPSULE_STATE,
  OVERLAY_AUTO_SEND_INTENTS,
  OVERLAY_CLOSE,
  OVERLAY_OPEN,
  OVERLAY_REPLACE,
  type CapsuleAction,
  type OverlayCapsuleState,
  type OverlayConfigReply,
  type OverlayIntent,
  type OverlayOpenPayload,
  type OverlayOpenState,
  type OverlayReplaceResult,
  type OverlaySelection,
} from "@/lib/overlay/protocol";
import { resolveInitialTranslateTarget } from "@/lib/overlay/translate-target";
import {
  applyOverlayEmit,
  capsuleSteps,
  createOverlayRun,
  detachedMessagesToPersist,
  isTerminalEmit,
  markStopped,
  type OverlayRun,
} from "@/lib/overlay/run-state";
import { getOverlaySettings, type OverlaySettings } from "@/lib/overlay/settings";
import { getAssistantLanguageSetting, resolveAssistantLanguage } from "@/lib/i18n/assistant-language";
import { resolveLocale } from "@/lib/i18n/locale-resolver";
import type { Locale } from "@/lib/i18n/locales";
import {
  attachPanel,
  clearPanelLog,
  createPanelFanout,
  detachPanel,
  panelAttached,
  postToPanel,
  type PanelFanout,
} from "@/lib/overlay/run-fanout";
import { makeT, normalizeBrowserLocale } from "@/lib/i18n";
import { readLocaleSetting } from "@/lib/i18n/locale-resolver";
import {
  forgetOverlaySession,
  isWithinRetention,
  recallOverlaySession,
  rememberOverlaySession,
} from "@/lib/overlay/tab-session";
import { createKeepAlive } from "./keep-alive";
import { openPanel } from "./panel-open";
import {
  DEEPLINK_KEY,
  DEEPLINK_OVERLAY_RESTRICTED,
  overlayPanelDeeplink,
  overlayPrefillDeeplink,
  settingsDeeplink,
} from "@/lib/deeplink";

// ── Run mirror ──────────────────────────────────────────────────────────────

export interface RunRuntime {
  run: OverlayRun;
  /** Live port while the overlay document is alive; null after detach. */
  port: chrome.runtime.Port | null;
  /** Side-panel client of the same run (live handoff). */
  panel: PanelFanout;
  abort: AbortController | null;
  /** True while the capsule stands in for the surface the user closed. */
  capsuleShown: boolean;
  finishedAt: number | null;
}

const runs = new Map<string, RunRuntime>();
const overlayInFlight = new Set<string>();
const overlayKeepAlive = createKeepAlive({
  tick: () => {
    // Any extension API call resets the SW idle timer.
    void chrome.runtime.getPlatformInfo();
  },
  inFlight: overlayInFlight,
});

const FINISHED_CAPSULE_TTL_MS = 60_000;

function safePost(port: chrome.runtime.Port | null, msg: unknown): void {
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch {
    // Port died (page navigated / overlay closed). The run mirror keeps going;
    // pending messages are persisted at the terminal emit instead.
  }
}

/**
 * Port shim for `makeTaskEmit`: it posts through the run's CURRENT port, so a
 * re-attached overlay document (new port) starts receiving immediately, and a
 * dead port drops messages instead of throwing inside the loop.
 */
export function makeOverlayPortShim(
  runtime: RunRuntime,
): Pick<chrome.runtime.Port, "postMessage"> {
  return {
    postMessage: (msg: unknown) => safePost(runtime.port, msg),
  } as Pick<chrome.runtime.Port, "postMessage">;
}

/** Register a run at chat-start. Returns the emit wrapper's shared runtime. */
export function startOverlayRun(
  sessionId: string,
  tabId: number,
  port: chrome.runtime.Port,
  abort: AbortController,
  panelPort?: chrome.runtime.Port,
): RunRuntime {
  const runtime: RunRuntime = {
    run: createOverlayRun(sessionId, tabId),
    port,
    panel: createPanelFanout(),
    abort,
    capsuleShown: false,
    finishedAt: null,
  };
  runs.set(sessionId, runtime);
  overlayInFlight.add(sessionId);
  overlayKeepAlive.ensure();
  // The side panel may already be showing this session; it becomes a live
  // client from the first emit on.
  if (panelPort) attachPanel(runtime.panel, panelPort, sessionId);
  return runtime;
}

/**
 * Bind a side-panel port to a live run (handoff mid-stream). Replays every
 * emit so far after a `chat-attach` preamble, so the panel continues the turn
 * instead of waiting for the detached run to persist.
 *
 * Returns false when there is no live run — the panel then just shows the
 * persisted conversation.
 */
export function attachPanelToRun(sessionId: string, port: chrome.runtime.Port): boolean {
  const rt = runs.get(sessionId);
  if (!rt || rt.run.status !== "run") return false;
  if (!attachPanel(rt.panel, port, sessionId)) return false;
  // The panel is alive and will persist the terminal state itself; keep the
  // overlay document's port (if any) as the other sink.
  return true;
}

export function detachPanelFromRun(sessionId: string, port: chrome.runtime.Port): void {
  const rt = runs.get(sessionId);
  if (rt) detachPanel(rt.panel, port);
}

/** `chat-abort` on a port that was attached to a run (the panel's Stop). */
export function abortOverlayRunFromPort(sessionId: string, port: chrome.runtime.Port): void {
  const rt = runs.get(sessionId);
  if (!rt || rt.panel.panel !== port) return;
  abortOverlayRun(sessionId);
}

export function getOverlayRun(sessionId: string): OverlayRun | null {
  return runs.get(sessionId)?.run ?? null;
}

/** A live (still running) overlay task for this session? */
export function isOverlayRunLive(sessionId: string): boolean {
  const rt = runs.get(sessionId);
  return rt !== undefined && rt.run.status === "run";
}

/** Called from port.onDisconnect: keep the task alive without its document. */
export function detachOverlayRun(sessionId: string): void {
  const rt = runs.get(sessionId);
  if (!rt) return;
  rt.run = { ...rt.run, detached: true };
  rt.port = null;
  // The page replaced the document mid-task: that is the one case where the
  // capsule is the ONLY surviving surface, so it is shown (a user-closed
  // overlay keeps its hidden document and does not come through here).
  if (rt.run.status === "run") {
    rt.capsuleShown = true;
    void pushCapsule(rt);
  }
}

/** The overlay reopened on the same tab while a task is still running. */
export function rebindOverlayRunPort(sessionId: string, port: chrome.runtime.Port): boolean {
  const rt = runs.get(sessionId);
  if (!rt || rt.run.status !== "run") return false;
  rt.port = port;
  // The user is back in the live conversation: the capsule has no job.
  clearCapsule(rt);
  // `detached` stays true: the SW remains the owner of persistence for this
  // run, so a re-attached overlay does not double-write the messages.
  return true;
}

/** The overlay surface is visible again (reused document or new mount). */
export function markOverlayReopened(sessionId: string | undefined): void {
  const rt = sessionId ? runs.get(sessionId) : undefined;
  if (!rt) return;
  clearCapsule(rt);
}

function clearCapsule(rt: RunRuntime): void {
  if (!rt.capsuleShown) return;
  rt.capsuleShown = false;
  void sendToTab(rt.run.tabId, { type: CAPSULE_STATE, state: null });
}

/**
 * The user closed the overlay (Esc / outside click / ×). If the task is still
 * running, THAT is when the capsule appears — never merely because a tool ran.
 */
export function markOverlayClosedByUser(sessionId: string | undefined, tabId?: number): void {
  const rt = sessionId ? runs.get(sessionId) : undefined;
  if (!rt || rt.run.status !== "run") return;
  if (typeof tabId === "number" && tabId !== rt.run.tabId) return;
  rt.capsuleShown = true;
  void pushCapsule(rt);
}

export function abortOverlayRun(sessionId: string): void {
  const rt = runs.get(sessionId);
  if (!rt) return;
  rt.abort?.abort();
  rt.run = markStopped(rt.run);
  void pushCapsule(rt);
}

/**
 * Wrap the loop's emit for an overlay run: mirror state, feed the capsule,
 * and persist when the document is gone.
 */
export function wrapOverlayEmit(
  runtime: RunRuntime,
  taskEmit: (m: PortMessageToPanel) => void,
): (m: PortMessageToPanel) => void {
  return (m: PortMessageToPanel): void => {
    const before = runtime.run;
    runtime.run = applyOverlayEmit(before, m);

    taskEmit(m);
    // A side panel attached to this run is a second live client (handoff):
    // it gets the same events, incl. the replay log for late attach.
    postToPanel(runtime.panel, m);

    // The capsule only mirrors a run the user already closed the overlay on.
    // Tool steps NEVER create it themselves (a bookmark write used to, which
    // collapsed the overlay for a tool that never touches the page).
    if (m.type === "agent-step" && runtime.capsuleShown) {
      void pushCapsule(runtime);
    }

    if (isTerminalEmit(m)) {
      runtime.finishedAt = Date.now();
      overlayInFlight.delete(runtime.run.sessionId);
      overlayKeepAlive.maybeStop();
      void finishRun(runtime);
    }
  };
}

function capsuleStateFor(run: OverlayRun): OverlayCapsuleState {
  const steps = capsuleSteps(run);
  return { status: run.status, sessionId: run.sessionId, steps };
}

async function pushCapsule(runtime: RunRuntime): Promise<void> {
  if (!runtime.capsuleShown) return;
  const tabId = runtime.run.tabId;
  const state = capsuleStateFor(runtime.run);
  await sendToTab(tabId, { type: CAPSULE_STATE, state });
}

async function finishRun(runtime: RunRuntime): Promise<void> {
  // A panel attached to the run received the terminal emit and persists the
  // turn itself; writing here too would duplicate the messages.
  const messages = panelAttached(runtime.panel) ? [] : detachedMessagesToPersist(runtime.run);
  if (messages.length > 0) {
    try {
      const meta = await getSessionMeta(runtime.run.sessionId);
      if (meta && meta.status !== "archived") {
        await persistSessionMessages(runtime.run.sessionId, [
          ...(meta.messages ?? []),
          ...(messages as DisplayMessage[]),
        ]);
      }
    } catch (e) {
      console.warn("[sw] overlay run persistence failed:", e);
    }
  }
  await pushCapsule(runtime);
  clearPanelLog(runtime.panel);
  // No capsule to dismiss → nothing left to remember about this run (a plain
  // Q&A leaves no surface behind).
  if (!runtime.capsuleShown) runs.delete(runtime.run.sessionId);
}

// ── Capsule (re)attach ──────────────────────────────────────────────────────

/**
 * Capsule state for a tab, or null. Used both by the content script's load
 * probe ("did a task survive the navigation?") and by tab activation.
 */
export function capsuleForTab(tabId: number): OverlayCapsuleState | null {
  for (const rt of runs.values()) {
    if (rt.run.tabId !== tabId) continue;
    if (!rt.capsuleShown) continue;
    if (rt.run.status !== "run" && rt.finishedAt !== null && Date.now() - rt.finishedAt > FINISHED_CAPSULE_TTL_MS) {
      continue;
    }
    return capsuleStateFor(rt.run);
  }
  return null;
}

/** The session an overlay on this tab belongs to (for "view" / probe flows). */
export function overlaySessionForTab(tabId: number): string | null {
  for (const rt of runs.values()) {
    if (rt.run.tabId === tabId && rt.capsuleShown) return rt.run.sessionId;
  }
  return null;
}

/** Drop the run record once the user dismissed its capsule. */
export function clearOverlayRun(sessionId: string): void {
  const rt = runs.get(sessionId);
  if (!rt) return;
  if (rt.run.status === "run") return; // never drop a live task
  runs.delete(sessionId);
}

export async function handleCapsuleAction(
  action: CapsuleAction,
  sessionId: string | undefined,
  senderTabId: number | undefined,
): Promise<void> {
  const rt = sessionId ? runs.get(sessionId) : undefined;
  const targetSession = rt?.run.sessionId ?? (typeof senderTabId === "number" ? overlaySessionForTab(senderTabId) : null);
  if (!targetSession) return;
  const tabId = rt?.run.tabId ?? senderTabId;

  if (action === "stop") {
    abortOverlayRun(targetSession);
    return;
  }

  clearOverlayRun(targetSession);
  if (typeof tabId === "number") await sendToTab(tabId, { type: CAPSULE_STATE, state: null });

  if (action === "expand") {
    await openSessionInPanel(targetSession, tabId);
    return;
  }
  // view / retry — back to the conversation in place.
  if (typeof tabId === "number") {
    await openOverlayOnTabId(tabId, { intent: "hotkey", selection: null, prompt: null, autoSend: false });
  }
}

// ── Tab helpers ─────────────────────────────────────────────────────────────

async function sendToTab(tabId: number, message: unknown): Promise<void> {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script (restricted page / not yet injected / tab gone).
  }
}

/** Ask the page for the live selection (text + editability). */
export async function askTabSelection(tabId: number): Promise<OverlaySelection | null> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, { type: "pie-overlay:ask-selection" })) as
      | OverlaySelection
      | null
      | undefined;
    return reply && typeof reply.text === "string" && reply.text.length > 0 ? reply : null;
  } catch {
    return null;
  }
}

/** Hide Pie's in-page surfaces around an operation that must not see them. */
export { hideSurfaces, showSurfaces, withSurfaceHidden } from "@/lib/overlay/surface-bridge";

// ── Opening ─────────────────────────────────────────────────────────────────

export interface OpenOverlayOptions {
  intent: OverlayIntent;
  selection: OverlaySelection | null;
  prompt: string | null;
  autoSend: boolean;
}

function isPageOverlayable(tab: chrome.tabs.Tab): boolean {
  if (typeof tab.id !== "number") return false;
  return canHostOverlay(tab.url, isPdfTab(tab));
}

/** Resolve which conversation this tab's overlay should show. */
async function resolveOverlaySession(
  tabId: number,
  settings: OverlaySettings,
): Promise<{ sessionId: string; resumed: boolean }> {
  const remembered = await recallOverlaySession(tabId);
  if (remembered && isWithinRetention(remembered.at, settings.retentionMinutes)) {
    const meta = await getSessionMeta(remembered.sessionId).catch(() => null);
    if (meta && meta.status !== "archived") {
      await rememberOverlaySession(tabId, meta.id);
      return { sessionId: meta.id, resumed: true };
    }
  }
  const meta = await createSession();
  await rememberOverlaySession(tabId, meta.id);
  return { sessionId: meta.id, resumed: false };
}

/**
 * Open the overlay on a tab — or the side panel when the page can't host one
 * (chrome://, the new-tab page, the Web Store, PDFs).
 */
export async function openOverlayOnTabId(tabId: number, opts: OpenOverlayOptions): Promise<void> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab) return;

  if (!isPageOverlayable(tab)) {
    // Restricted page: same shortcut, different surface. The panel explains
    // why in a one-line notice (deeplink), no error dialog.
    await stashDeeplink(DEEPLINK_OVERLAY_RESTRICTED);
    openPanel({ tabId }, "overlay-restricted");
    return;
  }

  const settings = await getOverlaySettings();
  const { sessionId, resumed } = await resolveOverlaySession(tabId, settings);
  const selection = opts.selection ?? (await askTabSelection(tabId));
  const prompt = opts.prompt;
  const autoSend = opts.autoSend;
  const pageTitle = tab.title ?? "";
  const pageUrl = tab.url ?? "";

  const payload: OverlayOpenPayload = {
    sessionId,
    tabId,
    intent: opts.intent,
    selection,
    prompt,
    autoSend,
    position: settings.position,
    resumed,
    pageTitle,
    pageUrl,
  };
  // Reopening the surface = back to the live conversation; a capsule standing
  // in for the closed overlay has no job any more.
  markOverlayReopened(sessionId);
  pendingOpens.set(tabId, {
    state: {
      sessionId,
      tabId,
      intent: opts.intent,
      selection,
      prompt,
      autoSend,
      resumed,
      position: settings.position,
      pageTitle,
      pageUrl,
    },
    at: Date.now(),
  });
  await sendToTab(tabId, { type: OVERLAY_OPEN, payload });
}

/** Hotkey entry: ⌘⇧K / Ctrl+Shift+K. */
export async function openOverlayFromCommand(): Promise<void> {
  const tab = await queryActiveHostTab();
  if (!tab || typeof tab.id !== "number") return;
  await openOverlayOnTabId(tab.id, { intent: "hotkey", selection: null, prompt: null, autoSend: false });
}

/** Selection-bar entry: the page already knows the intent; the overlay (not
 *  the page) builds the display text from its own dictionary, and the SW turns
 *  the structured task into the English model instruction. */
export async function handleOverlayIntent(
  senderTabId: number | undefined,
  intent: OverlayIntent,
  selection: OverlaySelection | null,
): Promise<void> {
  if (typeof senderTabId !== "number") return;
  await openOverlayOnTabId(senderTabId, {
    intent,
    selection,
    prompt: null,
    autoSend: OVERLAY_AUTO_SEND_INTENTS.has(intent),
  });
}

/** Omnibox entry: `pie <query>`. */
export async function handleOmniboxInput(text: string): Promise<void> {
  const query = text.trim();
  if (!query) return;
  const tab = await queryActiveHostTab();
  if (!tab || typeof tab.id !== "number") return;
  if (!isPageOverlayable(tab)) {
    await stashDeeplink(overlayPrefillDeeplink(query));
    openPanel({ tabId: tab.id }, "overlay-omnibox");
    return;
  }
  await openOverlayOnTabId(tab.id, {
    intent: "omnibox",
    selection: null,
    prompt: query,
    autoSend: true,
  });
}

/** Toolbar icon / handoff: open the side panel showing this session. */
export async function openSessionInPanel(sessionId: string, tabId: number | undefined): Promise<void> {
  await stashDeeplink(overlayPanelDeeplink(sessionId));
  if (typeof tabId === "number") {
    openPanel({ tabId }, "overlay-handoff");
    return;
  }
  const tab = await queryActiveHostTab().catch(() => undefined);
  if (typeof tab?.id === "number") openPanel({ tabId: tab.id }, "overlay-handoff");
  else if (typeof tab?.windowId === "number") openPanel({ windowId: tab.windowId }, "overlay-handoff");
}

async function stashDeeplink(value: string): Promise<void> {
  try {
    await chrome.storage.session.set({ [DEEPLINK_KEY]: value });
  } catch {
    // session storage unavailable — the panel just opens without the intent.
  }
}

/**
 * HITL handoff: an overlay run needs a panel-request card, and the in-page
 * surface cannot render one. Open the side panel on this session (the live
 * attach then carries the stream over) and tell the in-page overlay why.
 *
 * Returns false when this session has no overlay run — the caller keeps the
 * original "no sidepanel port" error for every other path.
 */
export async function ensurePanelForOverlayRequest(sessionId: string): Promise<boolean> {
  const rt = runs.get(sessionId);
  if (!rt) return false;
  // Without its document (detached run) there is nobody to notify — still open
  // the panel, which is where the card must live.
  safePost(rt.port, {
    type: "overlay-notice",
    sessionId,
    notice: "panel-request",
  });
  await openSessionInPanel(sessionId, rt.run.tabId);
  return true;
}

/** Overlay "不对" → the side panel's memory settings page. */
export async function openSettingsPageInPanel(page: "memory"): Promise<void> {
  await stashDeeplink(settingsDeeplink(page));
  const tab = await queryActiveHostTab().catch(() => undefined);
  if (typeof tab?.id === "number") openPanel({ tabId: tab.id }, "overlay-settings");
  else if (typeof tab?.windowId === "number") openPanel({ windowId: tab.windowId }, "overlay-settings");
}

/** Toolbar click: if this tab's overlay has a conversation, show it. */
export async function maybeStashOverlaySessionForToolbar(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") return;
  const remembered = await recallOverlaySession(tab.id);
  if (!remembered) return;
  const settings = await getOverlaySettings();
  if (!isWithinRetention(remembered.at, settings.retentionMinutes)) return;
  const meta = await getSessionMeta(remembered.sessionId).catch(() => null);
  // A run in flight has no persisted messages yet — it is exactly the case the
  // toolbar must hand over to (the panel attaches for the live stream).
  const live = isOverlayRunLive(remembered.sessionId);
  if (!meta || ((meta.messages?.length ?? 0) === 0 && !live)) return;
  await stashDeeplink(overlayPanelDeeplink(meta.id));
}

/** "＋ / ⌘K" — start a fresh conversation on this tab. */
export async function startNewOverlayChat(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab || !isPageOverlayable(tab)) return;
  const settings = await getOverlaySettings();
  const meta = await createSession();
  await rememberOverlaySession(tabId, meta.id);
  const position = settings.position;
  const pageTitle = tab.title ?? "";
  const pageUrl = tab.url ?? "";
  pendingOpens.set(tabId, {
    state: {
      sessionId: meta.id,
      tabId,
      intent: "hotkey",
      selection: null,
      prompt: null,
      autoSend: false,
      resumed: false,
      position,
      pageTitle,
      pageUrl,
    },
    at: Date.now(),
  });
  await sendToTab(tabId, {
    type: OVERLAY_OPEN,
    payload: {
      sessionId: meta.id,
      tabId,
      intent: "hotkey",
      selection: null,
      prompt: null,
      autoSend: false,
      position,
      resumed: false,
      pageTitle,
      pageUrl,
    } satisfies OverlayOpenPayload,
  });
}

// ── Overlay document requests ───────────────────────────────────────────────

/** The open payload lives in the SW: the document only carries ids in its URL
 *  (user text must not ride in a URL the page could observe in the DOM). */
const pendingOpens = new Map<number, { state: OverlayOpenState; at: number }>();
const PENDING_OPEN_TTL_MS = 5 * 60_000;

/** Mount state for the overlay document (it only knows its URL params). */
export async function overlayOpenState(sessionId: string, tabId: number): Promise<OverlayOpenState | null> {
  if (!sessionId) return null;
  const settings = await getOverlaySettings();
  const pending = pendingOpens.get(tabId);
  if (pending && pending.state.sessionId === sessionId && Date.now() - pending.at < PENDING_OPEN_TTL_MS) {
    return {
      ...pending.state,
      openedAt: pending.at,
      translateTarget: resolveInitialTranslateTarget(
        settings.lastTranslateLang,
        await resolveOverlayAnswerLocale(),
        pending.state.selection?.text ?? "",
      ),
    };
  }
  // No pending open (re-opened document): re-read the page identity so the
  // memory prefetch still gets title/URL.
  let pageTitle: string | undefined;
  let pageUrl: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    pageTitle = tab.title ?? "";
    pageUrl = tab.url ?? "";
  } catch {
    // Tab gone — the prefetch just runs without page context.
  }
  return {
    sessionId,
    tabId,
    // No pending open: the document was reloaded; the intent came from its URL.
    intent: "hotkey",
    selection: null,
    prompt: null,
    autoSend: false,
    resumed: false,
    position: settings.position,
    translateTarget: resolveInitialTranslateTarget(
      settings.lastTranslateLang,
      await resolveOverlayAnswerLocale(),
      "",
    ),
    ...(pageTitle !== undefined ? { pageTitle, pageUrl } : {}),
  };
}

/** The locale the assistant answers in (auto-detect → the UI locale). */
async function resolveOverlayAnswerLocale(): Promise<Locale> {
  const setting = await getAssistantLanguageSetting();
  const ui = await resolveLocale();
  const resolved = resolveAssistantLanguage(setting, ui);
  return resolved === "auto-detect-user-message" ? ui : resolved;
}

export function isOverlaySessionRunning(sessionId: string): boolean {
  return isOverlayRunLive(sessionId);
}

export async function handleOverlayReplace(
  tabId: number,
  original: string,
  text: string,
): Promise<OverlayReplaceResult> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, {
      type: OVERLAY_REPLACE,
      original,
      text,
    })) as OverlayReplaceResult | undefined;
    return reply ?? { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "stale" };
  }
}

export async function closeOverlayOnTab(tabId: number): Promise<void> {
  await sendToTab(tabId, { type: OVERLAY_CLOSE });
}

/** Should the overlay document be torn down after the user closed it? */
export function shouldKeepOverlayDocument(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return isOverlayRunLive(sessionId);
}

export async function forgetTabOverlay(tabId: number): Promise<void> {
  await forgetOverlaySession(tabId);
  for (const [sid, rt] of runs.entries()) {
    if (rt.run.tabId === tabId && rt.run.status !== "run") runs.delete(sid);
  }
}

/** True when a chrome.runtime port was opened by the overlay document (not the
 *  side panel). Used to decide whether a re-connect may adopt a running task. */
export function isOverlayDocumentPort(port: chrome.runtime.Port): boolean {
  try {
    return (port.sender?.url ?? "").startsWith(chrome.runtime.getURL("src/overlay/index.html"));
  } catch {
    return false;
  }
}

/** Settings + localized labels for the page-side bar / capsule.
 *
 * `browserLanguage` comes from the content script's `navigator.language` on
 * purpose: `chrome.i18n.getUILanguage()` reports the OS/app locale inside the
 * service worker but the browser UI locale inside extension pages, so trusting
 * it here would render the in-page bar in a different language than the panel
 * on the same machine. */
export async function overlayConfigReply(browserLanguage?: string): Promise<OverlayConfigReply> {
  const settings = await getOverlaySettings();
  const setting = await readLocaleSetting();
  const locale =
    setting !== "auto"
      ? setting
      : normalizeBrowserLocale(browserLanguage ?? chrome.i18n.getUILanguage());
  const t = makeT(locale);
  return {
    settings: {
      barEnabled: settings.barEnabled,
      excludedHosts: settings.excludedHosts,
      position: settings.position,
    },
    strings: {
      barAsk: t("overlay.bar.ask"),
      barExplain: t("overlay.bar.explain"),
      barTranslate: t("overlay.bar.translate"),
      barQuote: t("overlay.bar.quote"),
      barRewrite: t("overlay.bar.rewrite"),
      barMore: t("overlay.bar.more"),
      barHideSite: t("overlay.bar.hideSite"),
      capsuleStop: t("overlay.capsule.stop"),
      capsuleExpand: t("overlay.capsule.expand"),
      capsuleView: t("overlay.capsule.view"),
      capsuleRetry: t("overlay.capsule.retry"),
      capsulePanel: t("overlay.capsule.panel"),
      capsuleDone: t("overlay.capsule.done"),
      capsuleStopped: t("overlay.capsule.stopped"),
      capsuleFailed: t("overlay.capsule.failed"),
      activityReadPage: t("overlay.capsule.activity.readPage"),
      activityActPage: t("overlay.capsule.activity.actPage"),
      activityOpenPage: t("overlay.capsule.activity.openPage"),
      activityReadPdf: t("overlay.capsule.activity.readPdf"),
      activitySearchBookmarks: t("overlay.capsule.activity.searchBookmarks"),
      activitySearchHistory: t("overlay.capsule.activity.searchHistory"),
      activityBookmarks: t("overlay.capsule.activity.bookmarks"),
      activityMemory: t("overlay.capsule.activity.memory"),
      activityMonitor: t("overlay.capsule.activity.monitor"),
      activityOther: t("overlay.capsule.activity.other"),
    },
  };
}
