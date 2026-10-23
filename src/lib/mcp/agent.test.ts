import { describe, expect, it, vi } from "vitest";
import { prepareMcpForTask } from "./agent";
import { McpConnectionPool } from "./tools";
import type { StoredMcpServer } from "./store";
import { buildLoadToolsTool } from "../agent/tools/disclosure";
import { buildToolCatalogBlock, resolveLoadTools } from "../agent/disclosure";
import { buildAgentSystemPrompt } from "../agent/prompt";

vi.mock("./store", async (orig) => ({
  ...(await orig<typeof import("./store")>()),
  updateMcpToolsCache: vi.fn(async () => {}),
}));

const srv = (id: string, name: string, over: Partial<StoredMcpServer> = {}): StoredMcpServer => ({
  id, name, url: `http://localhost:8000/${id}`, enabled: true, consent: "always", createdAt: 1, updatedAt: 1, ...over,
});

/** Fake MCP server per URL path: `dead` refuses connections. */
function fakeFetch() {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/dead")) throw new TypeError("Failed to fetch");
    const b = JSON.parse(String(init?.body ?? "{}"));
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { headers: { "content-type": "application/json" } });
    if (b.method === "initialize") return reply({ protocolVersion: "2025-06-18" });
    if (b.method === "tools/list") {
      return reply({
        tools: [
          { name: "inspect_doc_structure", annotations: { readOnlyHint: true } },
          { name: "batch_update_doc" },
        ],
      });
    }
    if (b.method === "tools/call") return reply({ content: [{ type: "text", text: `called ${b.params.name}` }] });
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
}

async function prepare(servers: StoredMcpServer[]) {
  return prepareMcpForTask({
    vision: false,
    listServers: async () => servers,
    pool: new McpConnectionPool(async () => ({}), fakeFetch()),
    isApproved: async () => false,
    requestConsent: async () => true,
    recordApproval: async () => {},
  });
}

describe("prepareMcpForTask — one on-demand group per enabled server", () => {
  it("only enabled servers get a group + catalog line", async () => {
    const mcp = await prepare([
      srv("a", "Google Docs", { toolsCache: { tools: [{ name: "get_doc_content", readOnly: true }], at: 1 } }),
      srv("b", "Off", { enabled: false }),
    ]);
    expect(mcp.extraGroups.map((g) => g.id)).toEqual(["mcp:google_docs"]);
    expect(mcp.catalogLines).toEqual(['mcp:google_docs — external MCP server "Google Docs" — 1 tools: get_doc_content']);
  });

  it("no group loaded → no MCP tools in the tool table (no prompt bloat)", async () => {
    const mcp = await prepare([srv("a", "Docs")]);
    expect(await mcp.toolsForActiveGroups(new Set(["core"]))).toEqual([]);
  });

  it("load_tools(mcp:docs) connects, lists tools, and the next tool table contains them", async () => {
    const mcp = await prepare([srv("a", "Docs"), srv("b", "Other")]);
    const active = new Set<string>(["core"]);
    const loadTools = buildLoadToolsTool({ getActiveGroups: () => active, headless: false, extraGroups: mcp.extraGroups });

    const enumIds = (loadTools.parameters as { properties: { groups: { items: { enum: string[] } } } }).properties.groups.items.enum;
    expect(enumIds).toEqual(expect.arrayContaining(["mcp:docs", "mcp:other", "pdf"]));

    const r = await loadTools.handler({ groups: ["mcp:docs"] }, { tabId: 1 });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("mcp__docs__inspect_doc_structure");
    expect(active.has("mcp:docs")).toBe(true);

    const tools = await mcp.toolsForActiveGroups(active);
    expect(tools.map((t) => [t.name, t.toolClass])).toEqual([
      ["mcp__docs__inspect_doc_structure", "read"],
      ["mcp__docs__batch_update_doc", "write"],
    ]);
    const call = await tools[1].handler({ document_id: "d" }, { tabId: 1 });
    expect(call.observation).toContain("called batch_update_doc");
  });

  it("an unreachable server fails load_tools and is NOT left active", async () => {
    const mcp = await prepare([srv("dead", "Dead")]);
    const active = new Set<string>(["core"]);
    const loadTools = buildLoadToolsTool({ getActiveGroups: () => active, headless: false, extraGroups: mcp.extraGroups });
    const r = await loadTools.handler({ groups: ["mcp:dead"] }, { tabId: 1 });
    expect(r.success).toBe(false);
    expect(r.observation).toMatch(/Could not load mcp:dead/);
    expect(active.has("mcp:dead")).toBe(false);
  });

  it("stale group of a removed server (resumed task) is ignored", async () => {
    const mcp = await prepare([srv("a", "Docs")]);
    expect(await mcp.toolsForActiveGroups(new Set(["mcp:gone"]))).toEqual([]);
  });
});

describe("disclosure plumbing for runtime groups", () => {
  it("resolveLoadTools accepts extraLoadable ids, rejects unknown mcp ids", () => {
    const active = new Set<string>(["core"]);
    const r = resolveLoadTools(["mcp:docs", "mcp:nope"], active, { headless: false, extraLoadable: new Set(["mcp:docs"]) });
    expect(r).toEqual({ loaded: ["mcp:docs"], alreadyActive: [], unknown: ["mcp:nope"] });
  });

  it("catalog block and system prompt list MCP groups", () => {
    const line = 'mcp:docs — external MCP server "Docs"';
    expect(buildToolCatalogBlock(new Set(["core"]), [line])).toContain(`- ${line}`);
    const prompt = buildAgentSystemPrompt(true, true, [], undefined, [], undefined, new Set(["core"]), true, undefined, [line]);
    expect(prompt).toContain(line);
  });
});

describe("system prompt MCP block", () => {
  it("explicitly steers to load the server instead of operating the page", async () => {
    const { buildMcpServersBlock } = await import("../agent/prompt");
    expect(buildMcpServersBlock([])).toBe("");
    const block = buildMcpServersBlock(['mcp:google_docs — external MCP server "Google Docs" — 19 tools: get_doc_content']);
    expect(block).toContain("<external_mcp_servers>");
    expect(block).toContain('load_tools({groups:["mcp:…"]})');
    expect(block).toContain("docs.google.com");
    expect(block).toContain("- mcp:google_docs");
    expect(block.trim().endsWith("</external_mcp_servers>")).toBe(true);
  });

  it("servers no longer hide in the generic catalog", () => {
    const line = 'mcp:docs — external MCP server "Docs"';
    const prompt = buildAgentSystemPrompt(true, true, [], undefined, [], undefined, new Set(["core"]), true, undefined, [line]);
    const mcpBlock = prompt.slice(prompt.indexOf("<external_mcp_servers>"));
    expect(mcpBlock).toContain(line);
    expect(prompt.indexOf(line)).toBe(prompt.lastIndexOf(line)); // listed once
  });
});
