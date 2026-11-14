import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpServer, invalidateAllMcpServers } from "./connection";
import type { McpServerConfig } from "./types";

const cfg: McpServerConfig = {
  id: "srv1",
  name: "Docs",
  slug: "docs",
  url: "https://example.com/mcp",
  headers: {},
  createdAt: 0,
};

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Counts initialize calls and lets the test release each one by hand. */
function hangingFetch() {
  const inits: Array<Deferred<Response>> = [];
  const fetchMock = ((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.method === "initialize") {
      const d = deferred<Response>();
      inits.push(d);
      return d.promise;
    }
    if (body.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return Promise.resolve(
      json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "read_document" }] } }),
    );
  }) as unknown as typeof fetch;
  return { fetchMock, inits };
}

beforeEach(() => {
  invalidateAllMcpServers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectMcpServer sharing + abort", () => {
  it("aborting one waiter during the handshake rejects it fast without cancelling the shared handshake", async () => {
    const { fetchMock, inits } = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    const a = connectMcpServer(cfg, { signal: ac.signal });
    const b = connectMcpServer(cfg); // second session joins the same handshake
    // Let both callers reach the shared promise.
    await Promise.resolve();
    expect(inits).toHaveLength(1);

    ac.abort();
    await expect(a).rejects.toThrow(/aborted/);

    // The shared handshake is untouched: B resolves once the server answers.
    inits[0]!.resolve(json({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s1" }));
    const liveB = await b;
    expect(liveB.tools.map((t) => t.name)).toEqual(["read_document"]);
    expect(inits).toHaveLength(1); // exactly one initialize
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { fetchMock, inits } = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ac = new AbortController();
    ac.abort();
    await expect(connectMcpServer(cfg, { signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(inits).toHaveLength(0);
  });
});

describe("connectMcpServer invalidation race", () => {
  it("does not resurrect a stale handshake after the cache was invalidated", async () => {
    const { fetchMock, inits } = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    // Generation 1 starts and hangs.
    const stale = connectMcpServer(cfg);
    await Promise.resolve();
    expect(inits).toHaveLength(1);

    // Config edit / "test connection" invalidates while gen 1 is in flight.
    invalidateAllMcpServers();

    // Generation 2 starts (a fresh initialize) and completes first.
    const fresh = connectMcpServer(cfg);
    await Promise.resolve();
    expect(inits).toHaveLength(2);
    inits[1]!.resolve(json({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "new" }));
    const freshLive = await fresh;
    expect(freshLive.client.sessionId).toBe("new");

    // The stale handshake now completes — it must NOT overwrite the cache.
    inits[0]!.resolve(json({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "old" }));
    await stale;

    // Next connect reuses the fresh cached connection: no third initialize.
    const again = await connectMcpServer(cfg);
    expect(again.client.sessionId).toBe("new");
    expect(inits).toHaveLength(2);
  });
});
