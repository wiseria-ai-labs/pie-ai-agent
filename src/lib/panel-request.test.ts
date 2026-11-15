import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerPanelPort,
  unregisterPanelPort,
  requestFromPanel,
  handlePanelResponse,
  resolvePendingByKind,
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

  it("rejects all pending for a session when the panel port unregisters", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    unregisterPanelPort("S1");
    await expect(p).rejects.toThrow(/panel closed/i);
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

  // ── Abort: Stop must reject pending, clean pendingByRequestId, and dismiss card ──
  it("abort rejects pending with AbortError, cleans pendingByRequestId, and posts panel-request-resolved", async () => {
    const controller = new AbortController();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {}, { signal: controller.signal });
    expect(port.sent).toHaveLength(1);
    const requestId = port.sent[0].requestId;

    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(
      port.sent.some((m) => m.type === "panel-request-resolved" && m.sessionId === "S1" && m.requestId === requestId),
    ).toBe(true);

    // Cleaned from pendingByRequestId: late handlePanelResponse and resolvePendingByKind do not touch it.
    const countBefore = port.sent.length;
    handlePanelResponse(requestId, { ok: true, data: true });
    resolvePendingByKind("cdp-consent", true);
    expect(port.sent).toHaveLength(countBefore);
  });

  it("rejects immediately with AbortError and posts nothing when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = fakePort();
    registerPanelPort("S1", port);
    await expect(
      requestFromPanel("S1", "cdp-consent", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(port.sent).toHaveLength(0);
  });

  it("abort after panel response is a no-op (no duplicate post, no throw)", async () => {
    const controller = new AbortController();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {}, { signal: controller.signal });
    const requestId = port.sent[0].requestId;
    handlePanelResponse(requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);

    expect(() => controller.abort()).not.toThrow();
    expect(port.sent.some((m) => m.type === "panel-request-resolved")).toBe(false);
    expect(port.sent).toHaveLength(1);
  });

  it("timeout vs abort race: timeout first settles once, subsequent abort is a no-op", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const port = fakePort();
      registerPanelPort("S1", port);
      const p = requestFromPanel<"local-file">("S1", "local-file", {}, {
        timeoutMs: 1000,
        signal: controller.signal,
      });
      const reqId = port.sent[0].requestId;
      const assertion = expect(p).rejects.toThrow(/timed out/i);
      vi.advanceTimersByTime(1001);
      await assertion;

      expect(() => controller.abort()).not.toThrow();
      expect(port.sent.filter((m) => m.requestId === reqId && m.type === "panel-request-timeout")).toHaveLength(1);
      expect(port.sent.some((m) => m.type === "panel-request-resolved")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout vs abort race: abort first settles once, subsequent timeout advance is a no-op", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const port = fakePort();
      registerPanelPort("S1", port);
      const p = requestFromPanel<"local-file">("S1", "local-file", {}, {
        timeoutMs: 1000,
        signal: controller.signal,
      });
      const reqId = port.sent[0].requestId;
      controller.abort();
      await expect(p).rejects.toMatchObject({ name: "AbortError" });

      vi.advanceTimersByTime(2000);
      expect(port.sent.filter((m) => m.requestId === reqId && m.type === "panel-request-resolved")).toHaveLength(1);
      expect(port.sent.some((m) => m.type === "panel-request-timeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
