// Run-level MCP orchestration (issue #481).
//
// Extracted from the agent loop so the loop keeps a couple of one-line call
// sites instead of ~100 lines of server snapshot / activation / resume / tool
// ordering. Everything that needs a unit test lives here:
//
//   const mcp = await createMcpRun({ sessionId, signal, isHeadless, activeToolGroups });
//   system prompt catalog ← mcp.catalogLines
//   load_tools extras     ← mcp.loadToolsExtraGroups
//   tool array            ← mcp.tools()          (sorted, byte-stable)
//   first observation     ← mcp.drainStartupNotices()
//
// Snapshot semantics: servers are read once at task start (the catalog + tool
// enum are part of the cached prompt prefix, #175). Headless runs see nothing;
// resumed `mcp:*` groups reconnect in parallel and dead ones are dropped with a
// trusted notice (server error text never enters `<system_notice>`).

import type { Tool } from "../agent/types";
import type { ExtraLoadableGroup } from "../agent/tools/disclosure";
import { requestFromPanel } from "../panel-request";
import { isMcpServerApprovedInSession, recordMcpServerApproval } from "../sessions/storage";
import {
  activateMcpServer,
  dropMcpGroups,
  makeSessionMcpConfirm,
  restoreMcpGroups,
  type McpActivateResult,
  type McpToolsDeps,
} from "./agent-tools";
import { connectMcpServer, type LiveMcpServer } from "./connection";
import { mcpCatalogLine, mcpGroupId, mcpSlugFromGroup } from "./names";
import { listMcpServers } from "./store";
import type { McpServerConfig } from "./types";

/** Test seams — production callers pass nothing. */
export interface McpRunDeps {
  listServers?: () => Promise<McpServerConfig[]>;
  activate?: (cfg: McpServerConfig, deps: McpToolsDeps) => Promise<McpActivateResult>;
  connect?: (cfg: McpServerConfig, opts: { signal?: AbortSignal }) => Promise<LiveMcpServer>;
}

export interface McpRun {
  /** `<available_tools_catalog>` lines for servers not active yet (format: `<id> — <text>`). */
  catalogLines: string[];
  /** Dynamic `load_tools` groups — one per configured server. */
  loadToolsExtraGroups: ExtraLoadableGroup[];
  /** Tools of the groups activated so far, sorted by name (byte-stable). */
  tools: () => Tool[];
  /** Resumed groups that could not be restored — drains once (first merged observation). */
  drainStartupNotices: () => string[];
}

export async function createMcpRun(args: {
  sessionId: string;
  signal: AbortSignal;
  isHeadless: boolean;
  activeToolGroups: Set<string>;
  deps?: McpRunDeps;
}): Promise<McpRun> {
  const { sessionId, signal, isHeadless, activeToolGroups, deps } = args;
  const servers = isHeadless
    ? []
    : await (deps?.listServers ?? listMcpServers)().catch(() => []);
  const bySlug = new Map(servers.map((s) => [s.slug, s]));
  const toolsByGroup = new Map<string, Tool[]>();
  const startupNotices: string[] = [];

  const toolsDeps = (cfg: McpServerConfig): McpToolsDeps => ({
    callTool: async (toolName, callArgs, callSignal) => {
      const live = await (deps?.connect ?? connectMcpServer)(cfg, { signal: callSignal });
      return live.client.callTool(toolName, callArgs, { signal: callSignal });
    },
    // Per-session × per-server approval (D1=A). The approval signal only ever
    // arrives via the panel-request round-trip — the LLM cannot self-approve.
    confirm: makeSessionMcpConfirm({
      isApproved: (id) => isMcpServerApprovedInSession(sessionId, id),
      requestConfirm: (p) => requestFromPanel(sessionId, "mcp-tool-confirm", p),
      record: (id) => recordMcpServerApproval(sessionId, id),
    }),
    signal,
  });

  const activate = deps?.activate ?? activateMcpServer;
  /** Connect + plan one server's tools; register them only on success. */
  const activateGroup = async (group: string): Promise<{ ok: boolean; message: string }> => {
    const slug = mcpSlugFromGroup(group);
    const cfg = slug ? bySlug.get(slug) : undefined;
    if (!cfg) {
      return {
        ok: false,
        message: `Unknown MCP server group "${group}" — the server was deleted or renamed.`,
      };
    }
    const res = await activate(cfg, toolsDeps(cfg));
    if (res.ok) toolsByGroup.set(group, res.tools);
    return { ok: res.ok, message: res.message };
  };

  if (isHeadless) {
    // Nobody can answer the confirm card in a headless run.
    dropMcpGroups(activeToolGroups);
  } else {
    for (const group of await restoreMcpGroups(activeToolGroups, activateGroup)) {
      startupNotices.push(
        `The MCP tool group \`${group}\` from the resumed task is no longer usable and was dropped.`,
      );
    }
  }

  return {
    catalogLines: servers
      .filter((s) => !activeToolGroups.has(mcpGroupId(s.slug)))
      .map((s) => `${mcpGroupId(s.slug)} — ${mcpCatalogLine(s.name)}`),
    loadToolsExtraGroups: servers.map((s) => {
      const id = mcpGroupId(s.slug);
      return { id, catalogLine: mcpCatalogLine(s.name), load: () => activateGroup(id) };
    }),
    tools: () =>
      [...toolsByGroup.values()]
        .flat()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    drainStartupNotices: () => startupNotices.splice(0),
  };
}
