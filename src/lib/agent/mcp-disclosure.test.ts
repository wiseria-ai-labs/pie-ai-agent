import { describe, expect, it, vi } from "vitest";
import { buildToolCatalogBlock, selectTools } from "./disclosure";
import { buildLoadToolsTool } from "./tools/disclosure";
import { getToolClass, getToolGroup } from "./tool-names";
import { collectCrossSessionConflicts } from "./loop";
import { dropMcpGroups, restoreMcpGroups } from "../mcp/agent-tools";

// #481 — progressive-disclosure integration for remote MCP servers.

const mcpTool = { name: "mcp_docs_read_document", description: "d", parameters: {}, group: "mcp:docs",
  handler: async () => ({ success: true }), };

describe("MCP tool groups", () => {
  it("are filtered by their explicit group, not the core fallback", () => {
    expect(getToolGroup("mcp_docs_read_document")).toBe("core"); // registry fallback...
    // ...which is exactly why the Tool carries an explicit group:
    expect(selectTools([mcpTool], new Set(["core"]))).toEqual([]);
    expect(selectTools([mcpTool], new Set(["core", "mcp:docs"]))).toEqual([mcpTool]);
  });

  it("stay read-class so the R7 cross-session tab lock never fires", () => {
    expect(getToolClass("mcp_docs_read_document")).toBe("read");
    expect(collectCrossSessionConflicts("mcp_docs_read_document", { tabId: 7 }, 1, new Set([7]))).toEqual([]);
  });

  it("adds one catalog line per configured server", () => {
    const block = buildToolCatalogBlock(new Set(["core"]), ["mcp:docs: 用户接入的外部服务 Docs"]);
    expect(block).toContain("mcp:docs: 用户接入的外部服务 Docs");
    expect(buildToolCatalogBlock(new Set(["core"]), [])).not.toContain("mcp:");
  });
});

describe("load_tools with MCP groups", () => {
  it("lists them in the enum and activates only on success", async () => {
    const active = new Set<string>(["core"]);
    let ok = false;
    const load = async () => {
      if (!ok) return { ok: false, message: "unreachable: HTTP 403: Origin not allowed" };
      return { ok: true, message: 'MCP server "Docs" connected. Now available: mcp_docs_read.' };
    };
    const tool = buildLoadToolsTool({
      getActiveGroups: () => active,
      headless: false,
      extraGroups: [{ id: "mcp:docs", catalogLine: "Docs server", load }],
    });
    const enumIds = (tool.parameters as any).properties.groups.items.enum as string[];
    expect(enumIds).toContain("mcp:docs");
    expect(tool.description).toContain("mcp:docs");

    const failed = await tool.handler({ groups: ["mcp:docs"] }, {} as never);
    expect(failed.success).toBe(false);
    expect(failed.observation).toContain("Origin not allowed");
    expect(active.has("mcp:docs")).toBe(false);

    ok = true;
    const loaded = await tool.handler({ groups: ["mcp:docs"] }, {} as never);
    expect(loaded.success).toBe(true);
    expect(loaded.observation).toContain("mcp_docs_read");
    expect(active.has("mcp:docs")).toBe(true);

    const again = await tool.handler({ groups: ["mcp:docs"] }, {} as never);
    expect(again.observation).toContain("Already active");
  });

  it("trims requested extra ids (same rule as static groups)", async () => {
    const active = new Set<string>(["core"]);
    const load = vi.fn(async () => ({ ok: true, message: "loaded docs" }));
    const tool = buildLoadToolsTool({
      getActiveGroups: () => active,
      headless: false,
      extraGroups: [{ id: "mcp:docs", catalogLine: "Docs", load }],
    });
    const res = await tool.handler({ groups: [" mcp:docs "] }, {} as never);
    expect(res.success).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(active.has("mcp:docs")).toBe(true);
  });
});

describe("resume helpers", () => {
  it("restores reachable groups and drops the rest", async () => {
    const active = new Set(["core", "mcp:docs", "mcp:gone", "pdf"]);
    const dropped = await restoreMcpGroups(active, async (group) => ({ ok: group !== "mcp:gone" }));
    expect(dropped).toEqual(["mcp:gone"]);
    expect([...active].sort()).toEqual(["core", "mcp:docs", "pdf"]);
  });

  it("headless drops every MCP group", () => {
    const active = new Set(["core", "mcp:docs", "pdf"]);
    dropMcpGroups(active);
    expect([...active].sort()).toEqual(["core", "pdf"]);
  });
});
