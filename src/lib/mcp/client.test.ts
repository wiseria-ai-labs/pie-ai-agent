import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpClient,
  McpError,
  MCP_TOOL_CALL_TIMEOUT_MS,
  describeMcpError,
} from "./client";
import { connectMcpServer, __resetMcpConnectionsForTests } from "./connection";
import type { McpServerConfig } from "./types";

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(chunks: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

type Recorded = { method: string; id?: number; params?: any; headers: Headers };
type Handler = (req: Recorded) => Response | Promise<Response>;

function mockFetch(handler: Handler): { calls: Recorded[]; fetchMock: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchMock = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    const req: Recorded = {
      method: body.method,
      id: body.id,
      params: body.params,
      headers: new Headers(init.headers as HeadersInit),
    };
    calls.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { calls, fetchMock };
}

const cfg: McpServerConfig = {
  id: "srv1",
  name: "Docs",
  slug: "docs",
  url: "https://example.com/mcp?token=SECRET",
  headers: { Authorization: "Bearer SECRET" },
  createdAt: 0,
};

beforeEach(() => {
  __resetMcpConnectionsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("McpClient handshake + tools", () => {
  it("initializes, sends notifications/initialized, then lists tools", async () => {
    const { calls, fetchMock } = mockFetch((req) => {
      if (req.method === "initialize") {
        return json(
          { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", instructions: "be nice" } },
          { "mcp-session-id": "sess-1" },
        );
      }
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (req.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "read_document" }] } });
      }
      throw new Error(`unexpected ${req.method}`);
    });

    const client = new McpClient({ url: cfg.url, headers: cfg.headers, fetchImpl: fetchMock });
    await client.initialize();
    expect(client.sessionId).toBe("sess-1");
    expect(client.protocolVersion).toBe("2025-06-18");
    expect(client.instructions).toBe("be nice");

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["read_document"]);

    const init = calls[0]!;
    expect(init.headers.get("authorization")).toBe("Bearer SECRET");
    expect(init.headers.get("accept")).toContain("application/json");
    expect(init.headers.get("accept")).toContain("text/event-stream");
    const list = calls.find((c) => c.method === "tools/list")!;
    expect(list.headers.get("mcp-session-id")).toBe("sess-1");
    expect(list.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("parses SSE responses with CRLF line endings across chunks", async () => {
    const { fetchMock } = mockFetch((req) => {
      if (req.method === "initialize") {
        return json({ jsonrpc: "2.0", id: req.id, result: {} }, { "mcp-session-id": "s" });
      }
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: "hi" }] },
      });
      // Split mid-line and use CRLF + a foreign notification that must be ignored.
      return sse([
        "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\n",
        `event: message\r\ndata: ${payload.slice(0, 20)}`,
        `${payload.slice(20)}\r\n\r\n`,
      ]);
    });
    const client = new McpClient({ url: "https://x/mcp", fetchImpl: fetchMock });
    await client.initialize();
    const res = await client.callTool("x", {}, {});
    expect(res.content?.[0]?.text).toBe("hi");
  });

  it("parses a JSON payload split over multiple data: lines", async () => {
    const { fetchMock } = mockFetch((req) => {
      if (req.method === "initialize") {
        return json({ jsonrpc: "2.0", id: req.id, result: {} }, { "mcp-session-id": "s" });
      }
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: "multi" }] },
      });
      const cut = payload.indexOf(",") + 1;
      return sse([`data: ${payload.slice(0, cut)}\ndata: ${payload.slice(cut)}\n\n`]);
    });
    const client = new McpClient({ url: "https://x/mcp", fetchImpl: fetchMock });
    await client.initialize();
    const res = await client.callTool("x", {}, {});
    expect(res.content?.[0]?.text).toBe("multi");
  });

  it("follows nextCursor pages", async () => {
    let page = 0;
    const { fetchMock } = mockFetch((req) => {
      if (req.method === "initialize") {
        return json({ jsonrpc: "2.0", id: req.id, result: {} }, { "mcp-session-id": "s" });
      }
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (req.method === "tools/list") {
        page++;
        return json({
          jsonrpc: "2.0",
          id: req.id,
          result:
            page === 1
              ? { tools: [{ name: "a" }], nextCursor: "c1" }
              : { tools: [{ name: "b" }] },
        });
      }
      throw new Error("unexpected");
    });
    const client = new McpClient({ url: "https://x/mcp", fetchImpl: fetchMock });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("re-initializes once and retries the request on 404", async () => {
    const methods: string[] = [];
    let calls = 0;
    const { fetchMock } = mockFetch((req) => {
      methods.push(req.method);
      if (req.method === "initialize") {
        calls++;
        return json({ jsonrpc: "2.0", id: req.id, result: {} }, { "mcp-session-id": `sess-${calls}` });
      }
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (req.method === "tools/list") {
        if (calls === 1) return json({ message: "session expired" }, {}, 404);
        return json({ jsonrpc: "2.0", id: req.id, result: { tools: [] } });
      }
      throw new Error("unexpected");
    });
    const client = new McpClient({ url: "https://x/mcp", fetchImpl: fetchMock });
    await client.initialize();
    await client.listTools();
    expect(calls).toBe(2);
    expect(methods.filter((m) => m === "initialize").length).toBe(2);
  });

  it("surfaces HTTP status + body, and adds the Origin hint on 403", () => {
    const err = new McpError("HTTP 403", "http", 403, "Origin not allowed");
    const text = describeMcpError(err);
    expect(text).toContain("403");
    expect(text).toContain("Origin not allowed");
    expect(text).toContain("Origin: chrome-extension://");
    expect(describeMcpError(new McpError("HTTP 401", "http", 401, "bad token"))).toContain("401");
  });

  it("times out a tool call without hanging the loop", async () => {
    vi.useFakeTimers();
    const fetchMock = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://x/mcp", fetchImpl: fetchMock });
    const p = client.callTool("slow", {}, {});
    const assertion = expect(p).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(MCP_TOOL_CALL_TIMEOUT_MS + 10);
    await assertion;
  });
});

describe("connection sharing / abort isolation", () => {
  it("shares one handshake across concurrent callers", async () => {
    let inits = 0;
    const fetchMock = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") {
        inits++;
        return Promise.resolve(
          json({ jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "s" }),
        );
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(
        json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } }),
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([connectMcpServer(cfg), connectMcpServer(cfg)]);
    expect(inits).toBe(1);
    expect(a).toBe(b);
  });

  it("aborting one session's call does not tear down the shared connection", async () => {
    const fetchMock = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") {
        return Promise.resolve(
          json({ jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "s" }),
        );
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (body.method === "tools/list") {
        return Promise.resolve(json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
      }
      // tools/call — the "slow" one hangs until aborted, the other resolves.
      if (body.params?.name === "slow") {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(
        json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } }),
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const live = await connectMcpServer(cfg);
    const ctrl = new AbortController();
    const slow = live.client.callTool("slow", {}, { signal: ctrl.signal });
    const fast = live.client.callTool("fast", {}, {});
    ctrl.abort();
    await expect(slow).rejects.toBeTruthy();
    await expect(fast).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    // The handshake is still cached and usable.
    expect((await connectMcpServer(cfg)).client.sessionId).toBe("s");
  });
});
