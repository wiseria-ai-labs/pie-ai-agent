// HITL（human-in-the-loop）请求原语。
//
// 取代两份手搓实现（cdp-input-onboarding.ts / local-file-request.ts）：SW 挂起
// 一个 turn → 往 panel 发请求 → 等用户卡片裁决 → resolve/reject 一个 promise。
// 一个 session 一个 port，承载整条通道；pending 按 requestId 隔离，并发不串台。
//
// 注意：本原语**不是**风险拦截 confirm 层（那套已删，有 no-confirm-* 跨层测试守着）。
// 它只服务"工具语义即问人"（授权 / 选文件 / 选模型）的场景。
//
// 可靠性契约（2.0 真机 bug 修复）：
//   1. SW 侧 pending 保留 kind + payload，可**重投**。面板挂载 / 切换会话回来 /
//      端口重连都通过 `panel-request-sync` 或 `registerPanelPort` 触发重投，同一个
//      requestId 重发；面板按 requestId 去重，不会出现两张卡。
//   2. `requestFromPanel` 接受 `signal`：abort 时立刻丢弃 pending、reject，并给面板
//      发 `panel-request-resolved` 让卡片消失。Stop 必须能打断等待。
//   3. 端口断开（面板刷新 / swPort 重连）**不再** reject pending —— 重连后重投即可
//      恢复；真正放弃由用户 Stop（abort）或超时决定。

import type { LocalFileResult } from "./local-file-request";
import type { ScheduleDraftPayload, ScheduleModelSelection } from "./agent/tools/schedule-meta";
import type { SkillRunConfirmRequest } from "./agent/tools/skill-script";
import type {
  BookmarkPlanRequest,
  BrowserDataDomain,
  HistoryDeletionRequest,
} from "./browser-data/types";
import type { MonitorDraftPayload, MonitorDraftResponse } from "./agent/tools/monitor-meta";

/** kind 注册表：加一种人机交互 = 加一行，编译期校验 payload/返回。 */
export interface PanelRequestMap {
  "cdp-consent": { req: Record<string, never>; res: boolean };
  "local-file": { req: Record<string, never>; res: LocalFileResult };
  "schedule-model": { req: ScheduleDraftPayload; res: ScheduleModelSelection };
  "monitor-draft": { req: MonitorDraftPayload; res: MonitorDraftResponse };
  "run-local-agent": {
    req: { prompt: string; cwd: string; agents: { id: string; label: string }[] };
    res: string | null; // 用户选中的后端 agent id；null = 拒绝
  };
  "handoff-to-agent": {
    req: {
      context: string;
      opening?: string;
      fileCount: number;
      brands: {
        id: string;
        label: string;
        forms: { id: string; kind: "app" | "terminal"; appLaunch?: "deeplink" | "open-a" | "web" }[];
      }[];
    };
    res: string | null; // 用户选中的形态 id（claude-app 等）；null = 拒绝
  };
  "skill-run-confirm": { req: SkillRunConfirmRequest; res: boolean };
  /** 可选权限授权（书签 / 历史，分开授权）。res=用户在卡片上点了允许且 Chrome 授权成功。 */
  "browser-permission": { req: { domain: BrowserDataDomain }; res: boolean };
  /** 书签整理方案卡。res=用户点了「应用」；真正执行在 SW 工具处理器里。 */
  "bookmark-plan": { req: BookmarkPlanRequest; res: boolean };
  /** 历史删除卡（不可逆）。res=用户点了「删除 N 条」。 */
  "history-deletion": { req: HistoryDeletionRequest; res: boolean };
  /** 加密记忆授权：把（地址/联系方式类）条目的正文发给模型前问一次。
   *  res=true 只代表本次会话允许；拒绝 / 超时一律保持屏蔽。 */
  "memory-unlock": { req: { count: number; kinds: string[] }; res: boolean };
}
export type PanelRequestKind = keyof PanelRequestMap;

export interface PanelRequestOptions {
  timeoutMs?: number;
  panelAttachMs?: number;
  /** Abort the wait (user pressed Stop): drop the pending request and dismiss the card. */
  signal?: AbortSignal;
}

interface PendingRequest {
  sessionId: string;
  kind: PanelRequestKind;
  /** Retained so the request can be re-posted after a panel remount / reconnect. */
  payload: unknown;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Detach the abort listener once settled (any path). */
  cleanup?: () => void;
}

const portsBySession = new Map<string, chrome.runtime.Port>();
const pendingByRequestId = new Map<string, PendingRequest>();

/** 2.0 overlay — 没有 panel port 时的自动交棒钩子（只在 SW 里注册一次）。 */
type PanelOpener = (sessionId: string) => Promise<boolean>;
let panelOpener: PanelOpener | null = null;

/** 等待 panel port 出现的预算：深链 → 面板挂载 → 端口连接。 */
export const PANEL_ATTACH_TIMEOUT_MS = 15_000;

/** sessionId → 等端口的回调。端口注册时统一唤醒。 */
const portWaiters = new Map<string, Set<(port: chrome.runtime.Port) => void>>();

/**
 * 浮层 run 里没有面板可问时，SW 用它把面板拉起来（深链 + live attach）。
 * 返回 false 表示这不是一个可交棒的场景，调用方按原样报错。
 */
export function setPanelRequestOpener(opener: PanelOpener | null): void {
  panelOpener = opener;
}

/** Test-only：清空模块状态。 */
export function __resetPanelRequestState(): void {
  portsBySession.clear();
  portWaiters.clear();
  panelOpener = null;
  for (const p of pendingByRequestId.values()) {
    if (p.timer) clearTimeout(p.timer);
    p.cleanup?.();
  }
  pendingByRequestId.clear();
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Post to whatever port this session has right now; never throws. */
function post(sessionId: string, msg: Record<string, unknown>): void {
  const port = portsBySession.get(sessionId);
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch (e) {
    // Dead port — the pending entry survives and a reconnecting panel re-syncs.
    console.warn(`[sw] panel-request post failed for session=${sessionId}:`, e);
  }
}

function postRequest(sessionId: string, requestId: string, p: PendingRequest): void {
  post(sessionId, {
    type: "panel-request",
    sessionId,
    requestId,
    kind: p.kind,
    payload: p.payload,
  });
}

/** Re-post every still-pending request for a session (same requestId). */
function redeliverPending(sessionId: string): void {
  if (!portsBySession.has(sessionId)) return;
  for (const [requestId, p] of pendingByRequestId) {
    if (p.sessionId !== sessionId) continue;
    postRequest(sessionId, requestId, p);
  }
}

/**
 * 面板主动要一次全量重投（挂载 / 切回某会话 / 端口重连时发）。
 * 幂等：面板按 requestId 去重。
 */
export function resyncPanelRequests(sessionId: string): void {
  redeliverPending(sessionId);
}

export function registerPanelPort(sessionId: string, port: chrome.runtime.Port): void {
  portsBySession.set(sessionId, port);
  const waiters = portWaiters.get(sessionId);
  if (waiters) {
    portWaiters.delete(sessionId);
    for (const resolve of waiters) resolve(port);
  }
  // The SW may have delivered a card before this panel's listener existed
  // (overlay hand-off, remount). Re-post whatever is still waiting.
  redeliverPending(sessionId);
}

/** 等端口出现；超时或 abort 返回 undefined。已存在则同步返回。 */
function waitForPanelPort(
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<chrome.runtime.Port | undefined> {
  const existing = portsBySession.get(sessionId);
  if (existing) return Promise.resolve(existing);
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const set = portWaiters.get(sessionId) ?? new Set();
    portWaiters.set(sessionId, set);
    const onAbort = () => finish(undefined);
    const finish = (port: chrome.runtime.Port | undefined) => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) portWaiters.delete(sessionId);
      signal?.removeEventListener("abort", onAbort);
      resolve(port);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const done = (port: chrome.runtime.Port) => finish(port);
    set.add(done);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may have landed between the early return above and the listener
    // registration (an already-aborted signal never fires) — settle now.
    if (signal?.aborted) finish(undefined);
  });
}

/**
 * 端口断开：只清映射，**不** reject pending。
 *
 * 面板刷新 / swPort 透明重连 / 浮层交棒都会先断后连；旧实现把 pending 直接
 * reject 掉，正在等用户点卡的 turn 就无故失败了。现在 pending 留着，下一个端口
 * 注册时 `registerPanelPort` 立即重投；面板自己也会发 sync 再兜一层。
 *
 * `port` 可选：传入时只在"断的正是当前登记的那个端口"时才清映射（sibling 重连
 * 可能已经写入新 port，别误删）。
 */
export function unregisterPanelPort(sessionId: string, port?: chrome.runtime.Port): void {
  const current = portsBySession.get(sessionId);
  if (port && current && current !== port) return;
  portsBySession.delete(sessionId);
}

// ── Request ─────────────────────────────────────────────────────────────────

function abortError(kind: PanelRequestKind): Error {
  const err = new Error(`panel-request "${kind}" aborted`);
  err.name = "AbortError";
  return err;
}

export async function requestFromPanel<K extends PanelRequestKind>(
  sessionId: string,
  kind: K,
  payload: PanelRequestMap[K]["req"],
  opts?: PanelRequestOptions,
): Promise<PanelRequestMap[K]["res"]> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError(kind);

  let port = portsBySession.get(sessionId);
  if (!port) {
    // 2.0 overlay — an in-page run has no side panel to render a card in. Hand
    // the conversation over (open the panel + attach the live run) and wait for
    // its port, instead of throwing "no sidepanel port".
    let opened = false;
    try {
      opened = (await panelOpener?.(sessionId)) ?? false;
    } catch (e) {
      console.warn(`[sw] panel-request opener failed for session=${sessionId}:`, e);
    }
    if (!opened) {
      throw new Error(`Cannot send panel-request "${kind}": no sidepanel port for session ${sessionId}`);
    }
    port = await waitForPanelPort(sessionId, opts?.panelAttachMs ?? PANEL_ATTACH_TIMEOUT_MS, signal);
    if (signal?.aborted) throw abortError(kind);
    if (!port) {
      throw new Error(
        `Cannot send panel-request "${kind}": side panel did not attach for session ${sessionId}`,
      );
    }
  }

  const requestId = crypto.randomUUID();
  return new Promise<PanelRequestMap[K]["res"]>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs != null) {
      timer = setTimeout(() => {
        if (!pendingByRequestId.delete(requestId)) return;
        cleanup();
        post(sessionId, { type: "panel-request-timeout", sessionId, requestId });
        reject(new Error(`panel-request "${kind}" timed out`));
      }, opts.timeoutMs);
    }

    const onAbort = () => {
      if (!pendingByRequestId.delete(requestId)) return;
      if (timer) clearTimeout(timer);
      cleanup();
      // Dismiss the card — the turn is over, nobody should answer it.
      post(sessionId, { type: "panel-request-resolved", sessionId, requestId });
      reject(abortError(kind));
    };

    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const pending: PendingRequest = {
      sessionId,
      kind,
      payload,
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
      cleanup,
    };
    pendingByRequestId.set(requestId, pending);
    postRequest(sessionId, requestId, pending);
  });
}

/** Panel 回话：按 requestId 定位并 resolve/reject。未知 id 静默忽略。 */
export function handlePanelResponse(
  requestId: string,
  response: { ok: true; data: unknown } | { ok: false; reason: string },
): void {
  const pending = pendingByRequestId.get(requestId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.cleanup?.();
  pendingByRequestId.delete(requestId);
  if (response.ok) pending.resolve(response.data);
  else pending.reject(new Error(response.reason));
}

/**
 * 带外 resolve：不经 panel 回话，直接 resolve 某 kind 的全部 pending（跨 session）。
 * 用于 CDP 特例——另一个 session 把 cdp-input 开关翻 true 时自动放行所有等待中的
 * consent。同时给对应 panel 发 panel-request-resolved，让卡片消失。
 */
export function resolvePendingByKind<K extends PanelRequestKind>(
  kind: K,
  data: PanelRequestMap[K]["res"],
): void {
  for (const [reqId, p] of pendingByRequestId.entries()) {
    if (p.kind !== kind) continue;
    if (p.timer) clearTimeout(p.timer);
    p.cleanup?.();
    pendingByRequestId.delete(reqId);
    post(p.sessionId, { type: "panel-request-resolved", sessionId: p.sessionId, requestId: reqId });
    p.resolve(data);
  }
}
