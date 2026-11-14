import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerPanelPort,
  unregisterPanelPort,
  requestFromPanel,
  handlePanelResponse,
  resolvePendingByKind,
  setPanelRequestOpener,
  resyncPanelRequests,
  __resetPanelRequestState,
} from "./panel-request";

function fakePort() {
  const sent: any[] = [];
  return {
    sent,
    postMessage: (m: any) => sent.push(m),
  } as unknown as chrome.runtime.Port & { sent: any[] };
}

beforeEach(() => __resetPanelRequestState());

describe("panel-request", () => {
  it("throws when no port is registered for the session", async () => {
    await expect(
      requestFromPanel("S1", "cdp-consent", {}),
    ).rejects.toThrow(/no sidepanel port/i);
  });

  it("posts a panel-request with a requestId and resolves on matching response", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    expect(port.sent).toHaveLength(1);
    const msg = port.sent[0];
    expect(msg.type).toBe("panel-request");
    expect(msg.kind).toBe("cdp-consent");
    expect(typeof msg.requestId).toBe("string");
    handlePanelResponse(msg.requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);
  });

  it("isolates two concurrent requests by requestId (no cross-talk)", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const a = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const b = requestFromPanel<"local-file">("S1", "local-file", {});
    const [idA, idB] = port.sent.map((m) => m.requestId);
    expect(idA).not.toBe(idB);
    handlePanelResponse(idB, { ok: true, data: { name: "f", mime: "text/plain", text: "x", truncated: false } });
    handlePanelResponse(idA, { ok: true, data: false });
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toMatchObject({ name: "f" });
  });

  // ── Reliability: a card must survive the panel going away and coming back ──
  it("keeps a pending request across a port replacement and re-delivers it", async () => {
    const p1 = fakePort();
    registerPanelPort("S1", p1);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const requestId = p1.sent[0].requestId;

    // Panel refresh / swPort reconnect: old port drops, new one registers.
    unregisterPanelPort("S1", p1 as unknown as chrome.runtime.Port);
    const p2 = fakePort();
    registerPanelPort("S1", p2);

    const redelivered = p2.sent.find((m) => m.type === "panel-request" && m.requestId === requestId);
    expect(redelivered).toMatchObject({ kind: "cdp-consent", sessionId: "S1" });

    handlePanelResponse(requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);
  });

  it("ignores a stale port's unregister (sibling reconnect already replaced it)", async () => {
    const p1 = fakePort();
    const p2 = fakePort();
    registerPanelPort("S1", p1);
    registerPanelPort("S1", p2);
    unregisterPanelPort("S1", p1 as unknown as chrome.runtime.Port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    expect(p2.sent.some((m) => m.type === "panel-request")).toBe(true);
    handlePanelResponse(p2.sent[0].requestId, { ok: true, data: false });
    await expect(p).resolves.toBe(false);
  });

  it("re-posts on an explicit panel sync with the same requestId and payload", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    void requestFromPanel<"browser-permission">("S1", "browser-permission", { domain: "history" });
    const first = port.sent[0];
    resyncPanelRequests("S1");
    const again = port.sent.filter((m) => m.type === "panel-request").at(-1)!;
    expect(again.requestId).toBe(first.requestId);
    expect(again.payload).toEqual({ domain: "history" });
    handlePanelResponse(first.requestId, { ok: true, data: true });
  });

  it("does not re-post after the request settled", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    handlePanelResponse(port.sent[0].requestId, { ok: true, data: true });
    await p;
    resyncPanelRequests("S1");
    expect(port.sent.filter((m) => m.type === "panel-request")).toHaveLength(1);
  });

  // ── Abort: Stop must end the wait and dismiss the card ────────────────────
  it("abort rejects immediately, dismisses the card, and drops the pending", async () => {
    const controller = new AbortController();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {}, { signal: controller.signal });
    const requestId = port.sent[0].requestId;

    controller.abort();
    await expect(p).rejects.toThrow(/aborted/i);
    expect(port.sent.some((m) => m.type === "panel-request-resolved" && m.requestId === requestId)).toBe(true);

    // A late answer is a no-op — nothing is pending anymore.
    handlePanelResponse(requestId, { ok: true, data: true });
    resyncPanelRequests("S1");
    expect(port.sent.filter((m) => m.type === "panel-request")).toHaveLength(1);
  });

  it("rejects before posting when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = fakePort();
    registerPanelPort("S1", port);
    await expect(
      requestFromPanel("S1", "cdp-consent", {}, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(port.sent).toHaveLength(0);
  });

  it("abort also interrupts waiting for the panel to attach", async () => {
    setPanelRequestOpener(vi.fn(async () => true));
    const controller = new AbortController();
    const p = requestFromPanel("S1", "cdp-consent", {}, {
      panelAttachMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it("stops listening for abort once answered", async () => {
    const controller = new AbortController();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {}, { signal: controller.signal });
    handlePanelResponse(port.sent[0].requestId, { ok: true, data: true });
    await p;
    controller.abort();
    expect(port.sent.some((m) => m.type === "panel-request-resolved")).toBe(false);
  });

  it("rejects on timeout and posts a timeout dismiss", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"local-file">("S1", "local-file", {}, { timeoutMs: 1000 });
    const reqId = port.sent[0].requestId;
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(1001);
    await assertion;
    expect(port.sent.some((m) => m.type === "panel-request-timeout" && m.requestId === reqId)).toBe(true);
    vi.useRealTimers();
  });

  it("resolvePendingByKind resolves all pending of that kind and posts a resolved dismiss", async () => {
    const p1 = fakePort();
    const p2 = fakePort();
    registerPanelPort("S1", p1);
    registerPanelPort("S2", p2);
    const a = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const b = requestFromPanel<"cdp-consent">("S2", "cdp-consent", {});
    resolvePendingByKind("cdp-consent", true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(p1.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
    expect(p2.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
  });

  it("rejects when panel responds with ok: false", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    handlePanelResponse(port.sent[0].requestId, { ok: false, reason: "user cancelled" });
    await expect(p).rejects.toThrow("user cancelled");
  });

  it("ignores a response for an unknown requestId", () => {
    expect(() => handlePanelResponse("nope", { ok: true, data: true })).not.toThrow();
  });

  it("run-local-agent kind resolves the picked backend id via handlePanelResponse", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"run-local-agent">("S1", "run-local-agent", {
      prompt: "hi",
      cwd: "/tmp",
      agents: [{ id: "claude-terminal", label: "Claude Code (Terminal)" }],
    });
    const sent = port.sent.at(-1)!;
    handlePanelResponse(sent.requestId, { ok: true, data: "claude-terminal" });
    await expect(p).resolves.toBe("claude-terminal");
  });

  // 2.0 overlay — an in-page run has no panel to render the card in; the SW
  // hands the conversation over instead of failing the tool.
  describe("overlay run fallback (no panel port yet)", () => {
    it("opens the panel, waits for its port, then posts the request", async () => {
      const opener = vi.fn(async () => true);
      setPanelRequestOpener(opener);
      const p = requestFromPanel<"browser-permission">("S1", "browser-permission", {
        domain: "bookmarks",
      });

      // The panel boots asynchronously — its port shows up after the opener.
      const port = fakePort();
      registerPanelPort("S1", port);

      await vi.waitFor(() => expect(port.sent).toHaveLength(1));
      expect(opener).toHaveBeenCalledWith("S1");
      expect(port.sent[0]).toMatchObject({ type: "panel-request", kind: "browser-permission" });
      handlePanelResponse(port.sent[0].requestId, { ok: true, data: true });
      await expect(p).resolves.toBe(true);
    });

    it("keeps the hard error when the opener declines (not an overlay run)", async () => {
      setPanelRequestOpener(vi.fn(async () => false));
      await expect(requestFromPanel("S1", "cdp-consent", {})).rejects.toThrow(
        /no sidepanel port/i,
      );
    });

    it("rejects cleanly when the panel never attaches", async () => {
      setPanelRequestOpener(vi.fn(async () => true));
      await expect(
        requestFromPanel("S1", "cdp-consent", {}, { panelAttachMs: 5 }),
      ).rejects.toThrow(/did not attach/i);
    });
  });
});
