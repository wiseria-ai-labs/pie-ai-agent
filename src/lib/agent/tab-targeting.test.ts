import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  relaxTabIdSchema,
  toolTakesTabId,
  toolNeedsActiveTab,
  toolsToWireDefinitions,
  createTabActivator,
} from "./tab-targeting";
import { BUILT_IN_TOOLS } from "./tools";
import type { Tool } from "./types";

const schema = (tabIdDesc?: string, required?: string[]) => ({
  type: "object",
  properties: { tabId: { type: "integer", ...(tabIdDesc ? { description: tabIdDesc } : {}) }, q: { type: "string" } },
  ...(required ? { required } : {}),
});

describe("relaxTabIdSchema", () => {
  it("drops tabId from required and adds the hint", () => {
    const input = schema("Tab id to make active.", ["tabId", "q"]);
    const out = relaxTabIdSchema("activate_tab", input) as ReturnType<typeof schema>;
    expect(out.required).toEqual(["q"]);
    expect(out.properties.tabId.description).toBe("Tab id to make active. Leave out for the current tab.");
    // input not mutated
    expect(input.required).toEqual(["tabId", "q"]);
    expect(input.properties.tabId.description).toBe("Tab id to make active.");
  });

  it("removes an emptied required array and keeps an existing 'leave out' description", () => {
    const out = relaxTabIdSchema("read_page", schema("Leave out to read the current tab.", ["tabId"])) as ReturnType<typeof schema>;
    expect("required" in out).toBe(false);
    expect(out.properties.tabId.description).toBe("Leave out to read the current tab.");
  });

  it("leaves MCP tools and tabId-less schemas alone (same object)", () => {
    const mcp = schema("server tab", ["tabId"]);
    expect(relaxTabIdSchema("mcp__srv__tool", mcp)).toBe(mcp);
    const none = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    expect(relaxTabIdSchema("click", none)).toBe(none);
  });

  it("no built-in tool except unpin_tab requires tabId on the wire", () => {
    for (const d of toolsToWireDefinitions(BUILT_IN_TOOLS as Tool[])) {
      const req = (d.parameters as { required?: string[] }).required ?? [];
      if (d.name === "unpin_tab") continue;
      expect(req, d.name).not.toContain("tabId");
    }
  });
});

describe("toolTakesTabId / toolNeedsActiveTab", () => {
  it("classifies", () => {
    expect(toolTakesTabId({ name: "read_page", parameters: schema() })).toBe(true);
    expect(toolTakesTabId({ name: "mcp__a__b", parameters: schema() })).toBe(false);
    expect(toolTakesTabId({ name: "click", parameters: { type: "object", properties: {} } })).toBe(false);
    for (const n of ["read_page", "click", "type", "scroll", "navigate", "capture_visible_tab", "read_struct", "press_key"]) {
      expect(toolNeedsActiveTab(n), n).toBe(true);
    }
    for (const n of ["list_tabs", "close_tabs", "group_tabs", "move_tabs", "open_url", "done", "fail", "use_skill", "mcp__a__b"]) {
      expect(toolNeedsActiveTab(n), n).toBe(false);
    }
  });
});

describe("createTabActivator", () => {
  const tabs = { get: vi.fn(), update: vi.fn() };
  const windows = { update: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs, windows };
  });

  it("activates an inactive tab, skips an active one, never touches windows", async () => {
    const ensure = createTabActivator("s");
    tabs.get.mockResolvedValueOnce({ id: 5, active: false });
    await ensure(5);
    expect(tabs.update).toHaveBeenCalledWith(5, { active: true });
    tabs.get.mockResolvedValueOnce({ id: 5, active: true });
    await ensure(5);
    expect(tabs.update).toHaveBeenCalledTimes(1);
    expect(windows.update).not.toHaveBeenCalled();
  });

  it("swallows failures and ignores sentinel ids", async () => {
    const ensure = createTabActivator("s");
    tabs.get.mockRejectedValueOnce(new Error("No tab with id: 9"));
    await expect(ensure(9)).resolves.toBeUndefined();
    await ensure(-1);
    expect(tabs.get).toHaveBeenCalledTimes(1);
  });
});

describe("explicit tabId tools", () => {
  it("unpin_tab keeps a required tabId and is never auto-filled", () => {
    const tool = {
      name: "unpin_tab",
      parameters: { type: "object", properties: { tabId: { type: "integer" } }, required: ["tabId"] },
    };
    expect(toolTakesTabId(tool)).toBe(false);
    expect(relaxTabIdSchema(tool.name, tool.parameters)).toBe(tool.parameters);
  });
});
