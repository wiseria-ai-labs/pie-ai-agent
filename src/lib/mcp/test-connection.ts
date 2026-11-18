// Settings → MCP servers "test connection" (issue #481).
//
// Runs in the SW (the connection cache only exists there) and is shared with
// the panel through MCP_TEST_MESSAGE + McpTestResult so both sides speak one
// typed contract. Force-reconnects first: a cached handshake from an older
// config must never be reported as "test passed".

import { MCP_ERROR_MAX_CHARS, planMcpTools } from "./agent-tools";
import { describeMcpError } from "./client";
import { connectMcpServer, invalidateMcpServer } from "./connection";
import { listMcpServers } from "./store";

export const MCP_TEST_MESSAGE = "mcp:test";

export interface McpTestMessage {
  type: typeof MCP_TEST_MESSAGE;
  serverId: string;
}

export interface McpTestResult {
  ok: boolean;
  /** Exposed names (`mcp_<slug>_<tool>`) exactly as the agent will see them. */
  tools: string[];
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}

export async function testMcpServer(serverId: string): Promise<McpTestResult> {
  const cfg = (await listMcpServers()).find((s) => s.id === serverId);
  if (!cfg) {
    return { ok: false, tools: [], skipped: [], error: "server not found" };
  }
  invalidateMcpServer(serverId);
  try {
    const live = await connectMcpServer(cfg);
    const plan = planMcpTools(live);
    return { ok: true, tools: plan.entries.map((e) => e.exposed), skipped: plan.skipped };
  } catch (e) {
    return {
      ok: false,
      tools: [],
      skipped: [],
      error: describeMcpError(e).slice(0, MCP_ERROR_MAX_CHARS),
    };
  }
}
