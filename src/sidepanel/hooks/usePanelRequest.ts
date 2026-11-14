import { useEffect, useState, useCallback } from "react";
import { swPort } from "@/lib/sw-connection/manager";

export interface ActivePanelRequest {
  requestId: string;
  kind: string;
  payload: unknown;
}

export type PanelResponseBody = { ok: true; data: unknown } | { ok: false; reason: string };

interface State {
  /** 当前 session 待应答的请求；无则 null。一次至多一个。 */
  active: ActivePanelRequest | null;
  respond: (requestId: string, body: PanelResponseBody) => void;
}

/**
 * Panel 侧 HITL 分发：监听统一 `panel-request`，暴露当前待应答请求；`respond`
 * 回 `panel-response`。超时/带外放行（panel-request-timeout / -resolved）清卡。
 * 取代旧的 useCdpOnboarding / useLocalFileRequest。
 *
 * SW 连接服务 cutover：不再收 `port` prop。订阅经 `swPort.connect`（重连安全），
 * 回复经 `swPort.send`（SW idle-out 后透明重连重发）。
 */
export function usePanelRequest(sessionId: string | null): State {
  const [active, setActive] = useState<ActivePanelRequest | null>(null);

  useEffect(() => {
    // Switching sessions drops the card; if the new session has a suspended
    // request, the sync below brings it back immediately.
    setActive(null);
    if (!sessionId) return;
    const listener = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as {
        type?: string;
        sessionId?: string;
        requestId?: string;
        kind?: string;
        payload?: unknown;
      };
      if (m.sessionId !== sessionId) return;
      if (m.type === "panel-request" && m.requestId && m.kind) {
        // Same requestId re-delivered (sync / port reconnect) → keep the
        // existing object so the card keeps its internal state untouched.
        setActive((cur) =>
          cur && cur.requestId === m.requestId
            ? cur
            : { requestId: m.requestId!, kind: m.kind!, payload: m.payload },
        );
      } else if (
        m.type === "panel-request-timeout" ||
        m.type === "panel-request-resolved"
      ) {
        setActive((cur) => (cur && cur.requestId === m.requestId ? null : cur));
      }
    };
    const unsubscribe = swPort.connect(sessionId, { onMessage: listener });
    // Ask the SW to re-post anything still pending for this session. Covers
    // the hook mounting after the SW already delivered (e.g. overlay hand-off
    // opened the panel, or Chat mounted later than useSession's port) and
    // switching back to a session whose card is still suspended.
    swPort.send(sessionId, { type: "panel-request-sync", sessionId });
    return unsubscribe;
  }, [sessionId]);

  const respond = useCallback(
    (requestId: string, body: PanelResponseBody) => {
      if (!sessionId) return;
      swPort.send(sessionId, { type: "panel-response", sessionId, requestId, ...body });
      setActive((cur) => (cur && cur.requestId === requestId ? null : cur));
    },
    [sessionId],
  );

  return { active, respond };
}
