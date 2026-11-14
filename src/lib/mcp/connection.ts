// Per-server MCP connection cache (issue #481 §3).
//
// Lives in SW memory, shared across sessions (the whole point: two sessions
// asking for the same server share one handshake). Lazy — nothing connects
// until a tool group is activated or the settings page tests the server. SW
// eviction drops the cache; the next activation reconnects.
//
// The in-flight handshake is stored separately from the live entry so a second
// concurrent caller joins the SAME promise instead of starting a second
// initialize — and that promise carries no caller signal, so aborting one
// session's tool call can never tear down a handshake another session awaits.

import { McpClient } from "./client";
import { onStoreChange } from "../store-bus";
import { MCP_SERVERS_KEY } from "./store";
import type { McpServerConfig, McpToolDef } from "./types";

export interface LiveMcpServer {
  serverId: string;
  name: string;
  slug: string;
  client: McpClient;
  tools: McpToolDef[];
}

const live = new Map<string, LiveMcpServer>();
const inflight = new Map<string, Promise<LiveMcpServer>>();

export async function connectMcpServer(cfg: McpServerConfig): Promise<LiveMcpServer> {
  const existing = live.get(cfg.id);
  if (existing) return existing;
  const pending = inflight.get(cfg.id);
  if (pending) return pending;

  const p = (async (): Promise<LiveMcpServer> => {
    const client = new McpClient({ url: cfg.url, headers: cfg.headers });
    await client.initialize();
    const tools = await client.listTools();
    const entry: LiveMcpServer = {
      serverId: cfg.id,
      name: cfg.name,
      slug: cfg.slug,
      client,
      tools,
    };
    live.set(cfg.id, entry);
    return entry;
  })().finally(() => {
    inflight.delete(cfg.id);
  });
  inflight.set(cfg.id, p);
  return p;
}

export function getLiveMcpServer(serverId: string): LiveMcpServer | undefined {
  return live.get(serverId);
}

export function invalidateMcpServer(serverId: string): void {
  live.delete(serverId);
  inflight.delete(serverId);
}

export function invalidateAllMcpServers(): void {
  live.clear();
  inflight.clear();
}

/** Test-only. */
export function __resetMcpConnectionsForTests(): void {
  invalidateAllMcpServers();
}

// Config changed / server deleted → the cached handshake (and its tool list) is
// stale. Fires cross-context via BroadcastChannel, so the SW's cache follows a
// panel-side edit.
onStoreChange("config", (c) => {
  if (c.id === MCP_SERVERS_KEY) invalidateAllMcpServers();
});
