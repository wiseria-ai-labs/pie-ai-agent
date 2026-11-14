import { describe, expect, it, vi } from "vitest";
import { createMcpRun, type McpRunDeps } from "./run";
import type { Tool } from "../agent/types";
import type { McpServerConfig } from "./types";

const signal = new AbortController().signal;

function cfg(slug: string): McpServerConfig {
  return {
    id: `id-${slug}`,
    name: `Server ${slug}`,
    slug,
    url: `https://${slug}.example.com/mcp`,
    headers: {},
    createdAt: 0,
  };
}

/** Fake activation: one deterministic tool per server, or a failure. */
function fakeActivate(fail: ReadonlySet<string> = new Set()) {
  return vi.fn(async (c: McpServerConfig) => {
    if (fail.has(c.slug)) {
      return { ok: false, tools: [], skipped: [], message: `unreachable ${c.slug}` };
    }
    const tool: Tool = {
      name: `mcp_${c.slug}_read`,
      description: `${c.slug} read`,
      parameters: { type: "object", properties: {} },
      group: `mcp:${c.slug}`,
      handler: async () => ({ success: true }),
    };
    return { ok: true, tools: [tool], skipped: [], message: `connected ${c.slug}` };
  });
}

function deps(servers: McpServerConfig[], fail?: ReadonlySet<string>): McpRunDeps {
  return { listServers: async () => servers, activate: fakeActivate(fail) };
}

describe("createMcpRun", () => {
  it("headless: no servers are even read, no catalog, no extra groups, mcp groups dropped", async () => {
    const listServers = vi.fn(async () => [cfg("docs")]);
    const active = new Set(["core", "mcp:docs"]);
    const run = await createMcpRun({
      sessionId: "s",
      signal,
      isHeadless: true,
      activeToolGroups: active,
      deps: { listServers, activate: fakeActivate() },
    });
    expect(listServers).not.toHaveBeenCalled();
    expect(run.catalogLines).toEqual([]);
    expect(run.loadToolsExtraGroups).toEqual([]);
    expect(run.tools()).toEqual([]);
    expect(active.has("mcp:docs")).toBe(false);
  });

  it("resume: restores reachable groups in parallel, drops dead ones with one notice", async () => {
    const started: string[] = [];
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((r) => {
      releaseBoth = r;
    });
    const activate = vi.fn(async (c: McpServerConfig) => {
      started.push(c.slug);
      if (started.length === 2) releaseBoth();
      await bothStarted; // serial implementations deadlock here
      if (c.slug === "gone") {
        return { ok: false, tools: [], skipped: [], message: "unreachable gone" };
      }
      const tool: Tool = {
        name: `mcp_${c.slug}_read`,
        description: "",
        parameters: {},
        group: `mcp:${c.slug}`,
        handler: async () => ({ success: true }),
      };
      return { ok: true, tools: [tool], skipped: [], message: "ok" };
    });

    const active = new Set(["core", "mcp:ok", "mcp:gone"]);
    const run = await createMcpRun({
      sessionId: "s",
      signal,
      isHeadless: false,
      activeToolGroups: active,
      deps: { listServers: async () => [cfg("ok"), cfg("gone"), cfg("fresh")], activate },
    });

    expect(started.sort()).toEqual(["gone", "ok"]); // both in flight together
    expect(active.has("mcp:gone")).toBe(false);
    expect(active.has("mcp:ok")).toBe(true);
    expect(run.tools().map((t) => t.name)).toEqual(["mcp_ok_read"]);
    const notices = run.drainStartupNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("mcp:gone");
    expect(run.drainStartupNotices()).toEqual([]); // drains once
  });

  it("advertises configured servers that are not active, one line each, with an em dash", async () => {
    const run = await createMcpRun({
      sessionId: "s",
      signal,
      isHeadless: false,
      activeToolGroups: new Set(["core"]),
      deps: deps([cfg("docs"), cfg("notes")]),
    });
    expect(run.catalogLines).toHaveLength(2);
    for (const line of run.catalogLines) expect(line).toContain(" — ");
    expect(run.catalogLines[0]!.startsWith("mcp:docs — ")).toBe(true);
    expect(run.loadToolsExtraGroups.map((g) => g.id)).toEqual(["mcp:docs", "mcp:notes"]);
  });

  it("tools() is byte-identical regardless of activation order, and sorted by name", async () => {
    const servers = [cfg("alpha"), cfg("beta")];
    const runForward = await createMcpRun({
      sessionId: "s",
      signal,
      isHeadless: false,
      activeToolGroups: new Set(["core", "mcp:alpha", "mcp:beta"]),
      deps: deps(servers),
    });
    const runReverse = await createMcpRun({
      sessionId: "s",
      signal,
      isHeadless: false,
      activeToolGroups: new Set(["core", "mcp:beta", "mcp:alpha"]),
      deps: deps(servers),
    });
    expect(runForward.tools().map((t) => t.name)).toEqual(["mcp_alpha_read", "mcp_beta_read"]);
    expect(JSON.stringify(runForward.tools())).toBe(JSON.stringify(runReverse.tools()));
    // Two consecutive calls in the same state are identical too.
    expect(JSON.stringify(runForward.tools())).toBe(JSON.stringify(runForward.tools()));
  });

  it("load_extra_group activation registers tools", async () => {
    const run = await createMcpRun({
      sessionId: "s",
      signal,
      isHeadless: false,
      activeToolGroups: new Set(["core"]),
      deps: deps([cfg("docs")]),
    });
    expect(run.tools()).toEqual([]);
    const res = await run.loadToolsExtraGroups[0]!.load();
    expect(res.ok).toBe(true);
    // Activation registers the tools; the load_tools handler separately adds
    // the group id to the active set.
    expect(run.tools().map((t) => t.name)).toEqual(["mcp_docs_read"]);
  });
});
