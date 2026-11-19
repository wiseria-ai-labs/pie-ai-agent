import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  handlePanelResponse,
  registerPanelPort,
  unregisterPanelPort,
  __resetPanelRequestState,
} from "@/lib/panel-request";
import {
  installChromeApi,
  installFakeBookmarks,
  installFakePermissions,
  type FakeBookmarks,
} from "@/test/fake-browser-data";
import { BROWSER_DATA_TOOLS } from "./browser-data";

// Integration: the REAL panel-request primitive driven through a tool handler.
// browser-data.test.ts mocks the primitive; this file exercises the wiring that
// the 2.0 real-device bug lived in (suspended card + Stop + panel reconnect).

let bm: FakeBookmarks;

function tool(name: string) {
  const t = BROWSER_DATA_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function fakePort() {
  const sent: any[] = [];
  return {
    sent,
    postMessage: (m: any) => sent.push(m),
  } as unknown as chrome.runtime.Port & { sent: any[] };
}

beforeEach(async () => {
  await _resetForTests();
  __resetPanelRequestState();
  installChromeApi("permissions", installFakePermissions(["bookmarks"]));
  bm = installFakeBookmarks({ bar: [{ title: "Vectors", url: "https://a.example.com/vec" }] });
  installChromeApi("bookmarks", bm);
});

afterEach(() => {
  __resetPanelRequestState();
  const g = globalThis as unknown as { chrome: Record<string, unknown> };
  delete g.chrome.permissions;
  delete g.chrome.bookmarks;
});

describe("bookmark plan card — abort / reconnect", () => {
  it("Stop aborts the suspended tool, dismisses the card, and changes nothing", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const controller = new AbortController();
    const target = [...bm.nodes.values()].find((n) => n.title === "Vectors")!;

    const pending = tool("propose_bookmark_plan").handler(
      { ops: [{ op: "create_folder", title: "工作" }, { op: "move", id: target.id, parentId: "工作" }] },
      { tabId: 1, sessionId: "S1", signal: controller.signal },
    );

    await vi.waitFor(() =>
      expect(port.sent.some((m) => m.type === "panel-request" && m.kind === "bookmark-plan")).toBe(true),
    );
    const requestId = port.sent.find((m) => m.type === "panel-request").requestId;

    controller.abort();
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toContain("no changes were made");
    expect(port.sent.some((m) => m.type === "panel-request-resolved" && m.requestId === requestId)).toBe(true);
    // Nothing was created or moved.
    expect([...bm.nodes.values()].some((n) => n.title === "工作")).toBe(false);
  });

  it("re-delivers the card to a reconnected panel and applies on approval", async () => {
    const port1 = fakePort();
    registerPanelPort("S1", port1);
    const target = [...bm.nodes.values()].find((n) => n.title === "Vectors")!;
    const pending = tool("propose_bookmark_plan").handler(
      { ops: [{ op: "rename", id: target.id, title: "Vectors 2" }] },
      { tabId: 1, sessionId: "S1" },
    );

    await vi.waitFor(() => expect(port1.sent.some((m) => m.type === "panel-request")).toBe(true));
    const requestId = port1.sent.find((m) => m.type === "panel-request").requestId;

    // Panel reconnect: old port gone, new one registers → same card re-posted.
    unregisterPanelPort("S1", port1 as unknown as chrome.runtime.Port);
    const port2 = fakePort();
    registerPanelPort("S1", port2);
    expect(port2.sent.find((m) => m.type === "panel-request")?.requestId).toBe(requestId);

    handlePanelResponse(requestId, { ok: true, data: true });
    const res = await pending;
    expect(res.success).toBe(true);
    expect([...bm.nodes.values()].find((n) => n.id === target.id)!.title).toBe("Vectors 2");
  });

  it("a declined card still ends the tool cleanly (no undo row)", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const target = [...bm.nodes.values()].find((n) => n.title === "Vectors")!;
    const pending = tool("propose_bookmark_plan").handler(
      { ops: [{ op: "rename", id: target.id, title: "Nope" }] },
      { tabId: 1, sessionId: "S1" },
    );
    await vi.waitFor(() => expect(port.sent.some((m) => m.type === "panel-request")).toBe(true));
    handlePanelResponse(port.sent.find((m) => m.type === "panel-request").requestId, {
      ok: false,
      reason: "cancelled by user",
    });
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.browserChange).toBeUndefined();
  });
});
