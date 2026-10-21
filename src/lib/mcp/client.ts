// Minimal MCP client over Streamable HTTP (spec 2025-03-26+).
//
// Hand-written instead of @modelcontextprotocol/sdk: the SDK client validates
// tool output schemas with ajv, which compiles validators via `new Function` —
// forbidden by the MV3 extension CSP (no unsafe-eval). The wire protocol we
// need is small: initialize → notifications/initialized → tools/list →
// tools/call, each a JSON-RPC POST whose response is either application/json
// or a text/event-stream carrying the response message.
//
// Runs in the service worker (agent loop) and in the side panel (Settings →
// Test). Both are extension contexts with <all_urls> host permission, so
// fetch() to any server URL is not subject to CORS.
//
// Not supported: stdio (an extension can't spawn processes), the legacy
// 2024-11-05 HTTP+SSE transport (needs a long-lived GET stream — use a
// stdio/SSE→Streamable HTTP bridge), MCP OAuth (static headers only), and
// server→client requests (sampling / elicitation / roots are ignored).

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "pie-browser-agent", version: "1" };

export type McpErrorKind =
  | "http" // non-2xx response
  | "auth" // 401 / 403
  | "rpc" // JSON-RPC error object
  | "protocol" // malformed / unexpected response, unsupported version
  | "timeout"
  | "aborted"
  | "network"; // fetch() itself failed (server down, DNS, TLS)

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    }
  | { type: string; [k: string]: unknown };

export interface McpCallToolResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

export interface McpClientOptions {
  url: string;
  /** Static headers sent on every request (e.g. Authorization). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export class McpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initPromise: Promise<McpInitializeResult> | undefined;
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.headers = { ...(opts.headers ?? {}) };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  /**
   * Idempotent: concurrent callers share one handshake. The shared handshake
   * is bounded only by the client timeout, never by a caller's signal — the
   * pool shares one client across sessions, so session A's Stop must not fail
   * session B's in-flight call that happens to be waiting on the same
   * handshake. Each caller's own signal only abandons its own wait.
   */
  initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (!this.initPromise) {
      const p: Promise<McpInitializeResult> = this.handshake().catch((e) => {
        if (this.initPromise === p) this.initPromise = undefined;
        throw e;
      });
      this.initPromise = p;
    }
    return signal ? raceAbort(this.initPromise, signal) : this.initPromise;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    // Pagination guard — a server returning the same cursor forever must not hang us.
    for (let page = 0; page < 50; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {}, signal)) as {
        tools?: McpToolDef[];
        nextCursor?: string;
      };
      if (!r || !Array.isArray(r.tools)) {
        throw new McpError("protocol", "tools/list returned no tools array");
      }
      tools.push(...r.tools.filter((t) => t && typeof t.name === "string"));
      if (!r.nextCursor || r.nextCursor === cursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    const r = await this.request("tools/call", { name, arguments: args }, signal);
    if (!r || typeof r !== "object") {
      throw new McpError("protocol", "tools/call returned no result");
    }
    return r as McpCallToolResult;
  }

  /** Best-effort session teardown (DELETE). Never throws. */
  async close(): Promise<void> {
    const sid = this.sessionId;
    this.sessionId = undefined;
    this.initPromise = undefined;
    if (!sid) return;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: this.buildHeaders(sid),
      });
    } catch {
      // ignore
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async handshake(): Promise<McpInitializeResult> {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    const { message, sessionId } = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
      undefined,
      /* expectResponse */ true,
    );
    const result = unwrap(message) as McpInitializeResult;
    if (!result || typeof result.protocolVersion !== "string") {
      throw new McpError("protocol", "initialize returned no protocolVersion");
    }
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) {
      throw new McpError(
        "protocol",
        `Server speaks MCP protocol ${result.protocolVersion}; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}. ` +
          `Servers on the legacy HTTP+SSE transport (2024-11-05) need a Streamable HTTP bridge.`,
      );
    }
    this.sessionId = sessionId;
    this.protocolVersion = result.protocolVersion;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined, false);
    return result;
  }

  /**
   * Send a request after ensuring the session is initialized. If the server
   * answers 404 for our session id, the session expired: re-initialize once
   * and retry (spec: client MUST start a new session on 404).
   */
  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.initialize(signal);
    try {
      return await this.requestOnce(method, params, signal);
    } catch (e) {
      if (e instanceof McpError && e.kind === "http" && e.status === 404 && this.sessionId) {
        this.initPromise = undefined;
        await this.initialize(signal);
        return this.requestOnce(method, params, signal);
      }
      throw e;
    }
  }

  private async requestOnce(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const { message } = await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method, params },
      signal,
      true,
    );
    return unwrap(message);
  }

  private buildHeaders(sessionId = this.sessionId): Record<string, string> {
    const h: Record<string, string> = {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) h["Mcp-Session-Id"] = sessionId;
    if (this.protocolVersion) h["MCP-Protocol-Version"] = this.protocolVersion;
    return h;
  }

  private async post(
    body: { jsonrpc: "2.0"; id?: number; method: string; params?: unknown },
    outerSignal: AbortSignal | undefined,
    expectResponse: boolean,
  ): Promise<{ message: JsonRpcResponse; sessionId: string | undefined }> {
    const { signal, cleanup, timedOut } = withTimeout(outerSignal, this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        throw abortOr(e, outerSignal, timedOut, `${body.method}: cannot reach ${this.url}`);
      }

      const sessionId = res.headers.get("mcp-session-id") ?? undefined;
      if (res.status === 401 || res.status === 403) {
        // 403 is also how servers reject a disallowed Origin (DNS-rebinding
        // protection) — surface the body so "Origin not allowed" is visible.
        const text = await safeText(res);
        throw new McpError(
          "auth",
          `${body.method}: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}. ` +
            `Check the Authorization header in Settings → MCP servers, or allow this extension's origin on the server.`,
          res.status,
        );
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new McpError(
          "http",
          `${body.method}: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`,
          res.status,
        );
      }
      if (!expectResponse) {
        // Notifications: 202 Accepted with no body is the norm; drain anything else.
        await safeText(res);
        return { message: { jsonrpc: "2.0" }, sessionId };
      }

      const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
      let message: JsonRpcResponse | undefined;
      try {
        if (ctype.includes("text/event-stream")) {
          message = await readSseResponse(res, body.id!);
        } else {
          message = pickResponse(await res.json(), body.id!);
        }
      } catch (e) {
        if (e instanceof McpError) throw e;
        throw abortOr(e, outerSignal, timedOut, `${body.method}: malformed response`, "protocol");
      }
      if (!message) {
        throw new McpError("protocol", `${body.method}: no JSON-RPC response with id ${body.id}`);
      }
      return { message, sessionId };
    } finally {
      cleanup();
    }
  }
}

function unwrap(message: JsonRpcResponse): unknown {
  if (message.error) {
    throw new McpError(
      "rpc",
      `MCP error ${message.error.code}: ${message.error.message}`,
      undefined,
      message.error.code,
    );
  }
  return message.result;
}

function pickResponse(payload: unknown, id: number): JsonRpcResponse | undefined {
  const list = Array.isArray(payload) ? payload : [payload];
  return list.find(
    (m): m is JsonRpcResponse =>
      !!m && typeof m === "object" && String((m as JsonRpcResponse).id) === String(id) &&
      ("result" in m || "error" in m),
  );
}

/**
 * Read a text/event-stream body until the JSON-RPC response for `id` arrives.
 * Server notifications / requests on the same stream are skipped. Handles
 * \n and \r\n line endings and multi-line `data:` fields.
 */
async function readSseResponse(res: Response, id: number): Promise<JsonRpcResponse | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flushEvent = (): JsonRpcResponse | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined; // not JSON (e.g. keep-alive text) — skip
    }
    return pickResponse(parsed, id);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode() + "\n\n";
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const msg = flushEvent();
          if (msg) return msg;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(line[5] === " " ? 6 : 5));
        }
        // event:/id:/retry:/comments are irrelevant for request-scoped streams.
      }
      if (done) return undefined;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new McpError("aborted", "initialize: aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new McpError("aborted", "initialize: aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function withTimeout(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}

function abortOr(
  e: unknown,
  outer: AbortSignal | undefined,
  timedOut: () => boolean,
  context: string,
  fallbackKind: McpErrorKind = "network",
): McpError {
  if (timedOut()) return new McpError("timeout", `${context}: timed out`);
  if (outer?.aborted) return new McpError("aborted", `${context}: aborted`);
  const msg = e instanceof Error ? e.message : String(e);
  return new McpError(fallbackKind, `${context} (${msg})`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
}
