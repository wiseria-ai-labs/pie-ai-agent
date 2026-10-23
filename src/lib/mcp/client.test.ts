import { describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION, McpClient, McpError } from "./client";

type Handler = (body: { id?: number; method: string; params?: unknown }, init: RequestInit) => Response | Promise<Response>;

/** Fake fetch that routes JSON-RPC POSTs by method and records every request. */
function fakeServer(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; headers: Record<string, string>; body: unknown; httpMethod: string }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (init?.method === "DELETE") {
      calls.push({ method: "DELETE", headers, body: undefined, httpMethod: "DELETE" });
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    calls.push({ method: body.method, headers, body, httpMethod: "POST" });
    const h = handlers[body.method];
    if (!h) return new Response(null, { status: 202 });
    return h(body, init!);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const json = (obj: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json", ...headers } });

const sse = (chunks: string[], headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
  );

const initOk = (sessionId?: string, version = LATEST_PROTOCOL_VERSION): Handler => (b) =>
  json(
    { jsonrpc: "2.0", id: b.id, result: { protocolVersion: version, serverInfo: { name: "fake" }, capabilities: { tools: {} } } },
    sessionId ? { "mcp-session-id": sessionId } : {},
  );

const TOOLS = [{ name: "get_doc", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];

describe("McpClient — handshake", () => {
  it("initialize → notifications/initialized, then sends session + protocol headers", async () => {
    const { fetchImpl, calls } = fakeServer({
      initialize: initOk("sess-1"),
      "tools/list": (b) => json({ jsonrpc: "2.0", id: b.id, result: { tools: TOOLS } }),
    });
    const c = new McpClient({ url: "http://localhost:8000/mcp", headers: { Authorization: "Bearer t" }, fetchImpl });
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_doc"]);
    expect(calls.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    // initialize: our auth header + Accept both content types, no session yet
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer t", Accept: "application/json, text/event-stream" });
    expect(calls[0].headers["Mcp-Session-Id"]).toBeUndefined();
    expect((calls[0].body as { params: { protocolVersion: string } }).params.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    for (const later of calls.slice(1)) {
      expect(later.headers["Mcp-Session-Id"]).toBe("sess-1");
      expect(later.headers["MCP-Protocol-Version"]).toBe(LATEST_PROTOCOL_VERSION);
    }
  });

  it("accepts an older supported version the server negotiates down to", async () => {
    const { fetchImpl, calls } = fakeServer({
      initialize: initOk(undefined, "2025-03-26"),
      "tools/list": (b) => json({ jsonrpc: "2.0", id: b.id, result: { tools: [] } }),
    });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    await c.listTools();
    expect(calls.at(-1)!.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });

  it("rejects an unsupported protocol version", async () => {
    const { fetchImpl } = fakeServer({ initialize: initOk(undefined, "2024-11-05") });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    await expect(c.initialize()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("concurrent callers share one handshake", async () => {
    const { fetchImpl, calls } = fakeServer({
      initialize: initOk("s"),
      "tools/list": (b) => json({ jsonrpc: "2.0", id: b.id, result: { tools: [] } }),
    });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    await Promise.all([c.listTools(), c.listTools()]);
    expect(calls.filter((x) => x.method === "initialize")).toHaveLength(1);
  });
});

describe("McpClient — responses", () => {
  it("parses an SSE response, skipping server notifications, with CRLF line endings and split chunks", async () => {
    const { fetchImpl } = fakeServer({
      initialize: initOk("s"),
      "tools/call": (b) =>
        sse([
          'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
          'event: message\r\ndata: {"jsonrpc":"2.0","id":',
          `${b.id},"result":{"content":[{"type":"text","text":"hello"}]}}\r\n\r\n`,
        ]),
    });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    const r = await c.callTool("get_doc", { id: "1" });
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("joins multi-line data: fields", async () => {
    const { fetchImpl } = fakeServer({
      initialize: initOk(),
      "tools/list": (b) => sse([`data: {"jsonrpc":"2.0",\ndata: "id":${b.id},"result":{"tools":[]}}\n\n`]),
    });
    await expect(new McpClient({ url: "http://x/mcp", fetchImpl }).listTools()).resolves.toEqual([]);
  });

  it("follows tools/list pagination", async () => {
    const { fetchImpl } = fakeServer({
      initialize: initOk(),
      "tools/list": (b) => {
        const cursor = (b.params as { cursor?: string }).cursor;
        return json({
          jsonrpc: "2.0",
          id: b.id,
          result: cursor ? { tools: [{ name: "b" }] } : { tools: [{ name: "a" }], nextCursor: "p2" },
        });
      },
    });
    const tools = await new McpClient({ url: "http://x/mcp", fetchImpl }).listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("re-initializes once when the server drops the session (404)", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeServer({
      initialize: (b) => initOk(`sess-${++n}`)(b, {}),
      "tools/call": (b, init) =>
        (init.headers as Record<string, string>)["Mcp-Session-Id"] === "sess-1"
          ? new Response("session not found", { status: 404 })
          : json({ jsonrpc: "2.0", id: b.id, result: { content: [] } }),
    });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    await c.initialize();
    await expect(c.callTool("t", {})).resolves.toEqual({ content: [] });
    expect(calls.filter((x) => x.method === "initialize")).toHaveLength(2);
    expect(calls.at(-1)!.headers["Mcp-Session-Id"]).toBe("sess-2");
  });
});

describe("McpClient — errors", () => {
  it("maps a JSON-RPC error object to kind=rpc with code", async () => {
    const { fetchImpl } = fakeServer({
      initialize: initOk(),
      "tools/call": (b) => json({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "Unknown tool" } }),
    });
    const err = await new McpClient({ url: "http://x/mcp", fetchImpl }).callTool("nope", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ kind: "rpc", code: -32602 });
    expect(err.message).toContain("Unknown tool");
  });

  it("401 → kind=auth pointing at the Authorization header", async () => {
    const { fetchImpl } = fakeServer({ initialize: () => new Response("", { status: 401 }) });
    const err = await new McpClient({ url: "http://x/mcp", fetchImpl }).initialize().catch((e) => e);
    expect(err).toMatchObject({ kind: "auth", status: 401 });
    expect(err.message).toMatch(/Authorization/);
  });

  it("other non-2xx → kind=http with status and body snippet", async () => {
    const { fetchImpl } = fakeServer({ initialize: () => new Response("Origin not allowed", { status: 403 + 2 }) });
    const err = await new McpClient({ url: "http://x/mcp", fetchImpl }).initialize().catch((e) => e);
    expect(err).toMatchObject({ kind: "http", status: 405 });
    expect(err.message).toContain("Origin not allowed");
  });

  it("network failure → kind=network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await new McpClient({ url: "http://x/mcp", fetchImpl }).initialize().catch((e) => e);
    expect(err).toMatchObject({ kind: "network" });
  });

  it("abort via AbortSignal → kind=aborted", async () => {
    const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = new McpClient({ url: "http://x/mcp", fetchImpl }).initialize(ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
  });

  it("one caller aborting does not fail another caller sharing the handshake", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetchImpl } = fakeServer({
      initialize: async (b, init) => {
        await gate;
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return initOk("s1")(b, init);
      },
      "tools/list": (b) => json({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "t" }] } }),
    });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    const sessionA = new AbortController();
    const a = c.listTools(sessionA.signal);
    const b = c.listTools(new AbortController().signal);
    sessionA.abort();
    release();
    await expect(a).rejects.toMatchObject({ kind: "aborted" });
    await expect(b).resolves.toEqual([{ name: "t" }]);
  });

  it("timeout → kind=timeout", async () => {
    const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await expect(new McpClient({ url: "http://x/mcp", fetchImpl, timeoutMs: 20 }).initialize()).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("SSE stream that ends without our response → protocol error", async () => {
    const { fetchImpl } = fakeServer({
      initialize: initOk(),
      "tools/list": () => sse(['data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n']),
    });
    await expect(new McpClient({ url: "http://x/mcp", fetchImpl }).listTools()).rejects.toMatchObject({ kind: "protocol" });
  });
});

describe("McpClient — close", () => {
  it("DELETEs the session", async () => {
    const { fetchImpl, calls } = fakeServer({ initialize: initOk("s9") });
    const c = new McpClient({ url: "http://x/mcp", fetchImpl });
    await c.initialize();
    await c.close();
    const del = calls.find((x) => x.httpMethod === "DELETE");
    expect(del?.headers["Mcp-Session-Id"]).toBe("s9");
  });
});

describe("McpClient — 403 body surfaced", () => {
  it("Origin rejection text reaches the error message", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"Origin not allowed"}', { status: 403 })) as unknown as typeof fetch;
    const err = await new McpClient({ url: "http://x/mcp", fetchImpl }).initialize().catch((e) => e);
    expect(err).toMatchObject({ kind: "auth", status: 403 });
    expect(err.message).toContain("Origin not allowed");
  });
});
