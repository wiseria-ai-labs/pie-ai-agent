// HITL（human-in-the-loop）请求原语。
//
// 取代两份手搓实现（cdp-input-onboarding.ts / local-file-request.ts）：SW 挂起
// 一个 turn → 往 panel 发请求 → 等用户卡片裁决 → resolve/reject 一个 promise。
// 一个 session 一个 port，承载整条通道；pending 按 requestId 隔离，并发不串台。
//
// 注意：本原语**不是**风险拦截 confirm 层（那套已删，有 no-confirm-* 跨层测试守着）。
// 它只服务"工具语义即问人"（授权 / 选文件 / 选模型）的场景。

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
}
export type PanelRequestKind = keyof PanelRequestMap;

interface PendingRequest {
  sessionId: string;
  kind: PanelRequestKind;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
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
  for (const p of pendingByRequestId.values()) if (p.timer) clearTimeout(p.timer);
  pendingByRequestId.clear();
}

export function registerPanelPort(sessionId: string, port: chrome.runtime.Port): void {
  portsBySession.set(sessionId, port);
  const waiters = portWaiters.get(sessionId);
  if (waiters) {
    portWaiters.delete(sessionId);
    for (const resolve of waiters) resolve(port);
  }
}

/** 等端口出现；超时返回 undefined。已存在则同步返回。 */
function waitForPanelPort(
  sessionId: string,
  timeoutMs: number,
): Promise<chrome.runtime.Port | undefined> {
  const existing = portsBySession.get(sessionId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const set = portWaiters.get(sessionId) ?? new Set();
    portWaiters.set(sessionId, set);
    const finish = (port: chrome.runtime.Port | undefined) => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) portWaiters.delete(sessionId);
      resolve(port);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const done = (port: chrome.runtime.Port) => finish(port);
    set.add(done);
  });
}

/** Panel 关闭：reject 该 session 全部 pending，避免悬挂。 */
export function unregisterPanelPort(sessionId: string): void {
  portsBySession.delete(sessionId);
  for (const [reqId, p] of pendingByRequestId.entries()) {
    if (p.sessionId !== sessionId) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingByRequestId.delete(reqId);
    p.reject(new Error(`panel-request cancelled (panel closed) for session ${sessionId}`));
  }
}

export async function requestFromPanel<K extends PanelRequestKind>(
  sessionId: string,
  kind: K,
  payload: PanelRequestMap[K]["req"],
  opts?: { timeoutMs?: number; panelAttachMs?: number },
): Promise<PanelRequestMap[K]["res"]> {
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
    port = await waitForPanelPort(sessionId, opts?.panelAttachMs ?? PANEL_ATTACH_TIMEOUT_MS);
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
        pendingByRequestId.delete(requestId);
        const p = portsBySession.get(sessionId);
        if (p) p.postMessage({ type: "panel-request-timeout", sessionId, requestId });
        reject(new Error(`panel-request "${kind}" timed out`));
      }, opts.timeoutMs);
    }
    pendingByRequestId.set(requestId, {
      sessionId,
      kind,
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
    });
    port.postMessage({ type: "panel-request", sessionId, requestId, kind, payload });
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
    pendingByRequestId.delete(reqId);
    const port = portsBySession.get(p.sessionId);
    if (port) port.postMessage({ type: "panel-request-resolved", sessionId: p.sessionId, requestId: reqId });
    p.resolve(data);
  }
}
