// Per-server MCP connection cache (issue #481 §3).
//
// Lives in SW memory, shared across sessions (the whole point: two sessions
// asking for the same server share one handshake). Lazy — nothing connects
// until a tool group is activated or the settings page tests the server. SW
// eviction drops the cache; the next activation reconnects.
//
// The in-flight handshake is stored separately from the live entry so a second
// concurrent caller joins the SAME promise instead of starting a second
// initialize. That promise carries no caller signal: aborting one session's
// wait must never tear down a handshake another session awaits. Callers that
// want to stop waiting pass a `signal`, which races the shared promise.
//
// Invalidation (config edit / deleted server / settings "test connection")
// bumps nothing but clears the maps; a handshake that was already running must
// not resurrect itself, so results are cached only when this exact promise is
// still the registered in-flight one.

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

async function handshake(cfg: McpServerConfig): Promise<LiveMcpServer> {
  const client = new McpClient({ url: cfg.url, headers: cfg.headers });
  await client.initialize();
  const tools = await client.listTools();
  return { serverId: cfg.id, name: cfg.name, slug: cfg.slug, client, tools };
}

/**
 * Race a shared promise against a caller signal. Aborting rejects THIS caller
 * only — the shared handshake keeps running for everybody else.
 */
function raceWithSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export async function connectMcpServer(
  cfg: McpServerConfig,
  opts: { signal?: AbortSignal } = {},
): Promise<LiveMcpServer> {
  // Already-aborted caller: reject without touching the cache or starting a
  // handshake nobody asked for.
  if (opts.signal?.aborted) throw new Error("aborted");

  const existing = live.get(cfg.id);
  if (existing) return existing;

  let pending = inflight.get(cfg.id);
  if (!pending) {
    const p = handshake(cfg).then(
      (entry) => {
        // Promise identity: if the cache was invalidated while we were
        // connecting, this result is stale — never cache it, never delete a
        // newer in-flight handshake.
        if (inflight.get(cfg.id) === p) {
          live.set(cfg.id, entry);
          inflight.delete(cfg.id);
        }
        return entry;
      },
      (e) => {
        if (inflight.get(cfg.id) === p) inflight.delete(cfg.id);
        throw e;
      },
    );
    pending = p;
    inflight.set(cfg.id, p);
  }
  return raceWithSignal(pending, opts.signal);
}

export function invalidateMcpServer(serverId: string): void {
  live.delete(serverId);
  inflight.delete(serverId);
}

export function invalidateAllMcpServers(): void {
  live.clear();
  inflight.clear();
}

// Config changed / server deleted → the cached handshake (and its tool list) is
// stale. Fires cross-context via BroadcastChannel, so the SW's cache follows a
// panel-side edit.
onStoreChange("config", (c) => {
  if (c.id === MCP_SERVERS_KEY) invalidateAllMcpServers();
});
