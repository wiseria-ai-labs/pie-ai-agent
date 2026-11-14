// Minimal MCP Streamable HTTP client (issue #481 §3).
//
// Hand-rolled on purpose: the official @modelcontextprotocol/sdk client runs
// ajv, which compiles schemas with `new Function` — rejected by the MV3 CSP
// (`script-src 'self' 'wasm-unsafe-eval'`). Everything here is fetch + JSON.
//
// Flow: initialize → notifications/initialized → tools/list (cursor pages) →
// tools/call. Responses may be plain JSON or an SSE stream; SSE reuses the
// model-router parser (`\n` and `\r\n`). Requests echo `Mcp-Session-Id` and
// `MCP-Protocol-Version`; a 404 on an established session re-initializes once
// and retries the original request.
//
// Abort isolation: `initialize()` takes NO caller signal — the handshake is
// shared by every session using this server, so one session's abort must never
// tear it down. Only per-call requests (`tools/call`) accept a signal.

import { readSSELines } from "../model-router/sse";
import type { McpToolCallResult, McpToolDef } from "./types";

/** Newest first; the server picks and echoes one back. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_TOOL_CALL_TIMEOUT_MS = 180_000;
export const MCP_MAX_LIST_PAGES = 20;
export const MCP_ERROR_BODY_MAX_CHARS = 2_000;

export type McpErrorKind = "http" | "timeout" | "protocol" | "network";

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: McpErrorKind,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
}

export interface McpClientDeps {
  fetchImpl?: typeof fetch;
}

interface PostOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Internal: a 404 must not trigger the re-initialize retry. */
  noRetry?: boolean;
}

function composeAbort(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}

export class McpClient {
  private nextId = 1;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  sessionId?: string;
  protocolVersion?: string;
  /** Server-provided usage notes. UNTRUSTED — only ever fed to the model inside an untrusted wrapper. */
  instructions?: string;

  constructor(cfg: { url: string; headers?: Record<string, string> } & McpClientDeps) {
    this.url = cfg.url;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** Handshake. Deliberately takes no caller signal (shared across sessions). */
  async initialize(): Promise<void> {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    const res = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: "Pie", version: "1.0.0" },
      },
      { timeoutMs: MCP_REQUEST_TIMEOUT_MS, noRetry: true },
    );
    const result = (res.result ?? {}) as { protocolVersion?: unknown; instructions?: unknown };
    this.protocolVersion = typeof result.protocolVersion === "string"
      ? result.protocolVersion
      : MCP_PROTOCOL_VERSIONS[0];
    if (typeof result.instructions === "string") this.instructions = result.instructions;
    await this.notify("notifications/initialized");
  }

  async listTools(opts: PostOpts = {}): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {}, {
        ...opts,
        timeoutMs: opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
      });
      const result = (res.result ?? {}) as { tools?: unknown; nextCursor?: unknown };
      if (Array.isArray(result.tools)) {
        for (const t of result.tools) {
          if (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
            tools.push(t as McpToolDef);
          }
        }
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<McpToolCallResult> {
    const res = await this.request("tools/call", { name, arguments: args }, {
      signal: opts.signal,
      timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    });
    return (res.result ?? {}) as McpToolCallResult;
  }

  // ── wire ──────────────────────────────────────────────────────────────────

  private async request(
    method: string,
    params: unknown,
    opts: PostOpts,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    let res: JsonRpcResponse | null;
    try {
      res = await this.post(payload, opts);
    } catch (e) {
      // Session expired → one re-initialize + retry. `initialize` never lands
      // here (no session yet → `noRetry`).
      if (e instanceof McpError && e.status === 404 && this.sessionId && !opts.noRetry) {
        await this.initialize();
        res = await this.post({ ...payload, id: this.nextId++ }, { ...opts, noRetry: true });
      } else {
        throw e;
      }
    }
    if (res === null) throw new McpError(`empty response to ${method}`, "protocol");
    if (res.error) {
      const msg = typeof res.error.message === "string" ? res.error.message : JSON.stringify(res.error);
      throw new McpError(`JSON-RPC ${method} failed: ${msg}`, "protocol");
    }
    return res;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method }, { timeoutMs: MCP_REQUEST_TIMEOUT_MS, noRetry: true });
  }

  private async post(payload: unknown, opts: PostOpts): Promise<JsonRpcResponse | null> {
    const abort = composeAbort(opts.signal, opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      const headers: Record<string, string> = {
        ...this.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
    } catch (e) {
      abort.cleanup();
      if (abort.timedOut()) {
        throw new McpError(`request timed out after ${opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS}ms`, "timeout");
      }
      if (opts.signal?.aborted) throw e; // caller abort — propagate as-is
      throw new McpError(`network error: ${redactUrl(String(e instanceof Error ? e.message : e), this.url)}`, "network");
    }

    try {
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new McpError(
          `HTTP ${response.status}`,
          "http",
          response.status,
          body.slice(0, MCP_ERROR_BODY_MAX_CHARS),
        );
      }
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      const id = (payload as { id?: number }).id;
      if (id === undefined) return null; // notification: body is irrelevant
      if (response.status === 202) return null;

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        for await (const line of readSSELines(response, abort.signal)) {
          let msg: JsonRpcResponse;
          try {
            msg = JSON.parse(line.data) as JsonRpcResponse;
          } catch {
            continue;
          }
          // Ignore server→client requests / notifications; only our id matters.
          if (msg.id === id) return msg;
        }
        throw new McpError("SSE stream ended without a matching response", "protocol");
      }

      const text = await response.text();
      if (!text.trim()) return null;
      try {
        const msg = JSON.parse(text) as JsonRpcResponse;
        return Array.isArray(msg) ? ((msg.find((m) => m.id === id) as JsonRpcResponse) ?? null) : msg;
      } catch {
        throw new McpError("response is not valid JSON", "protocol");
      }
    } finally {
      abort.cleanup();
    }
  }
}

/**
 * Human-readable error text. The body is server-provided (UNTRUSTED) — callers
 * that feed it to the model must wrap it in `<untrusted_mcp_result>`.
 */
export function describeMcpError(e: unknown): string {
  if (!(e instanceof McpError)) {
    return e instanceof Error ? e.message : String(e);
  }
  const body = (e.body ?? "").trim();
  if (e.kind === "http") {
    const lines = [`HTTP ${e.status}${body ? `: ${body}` : ""}`];
    if (e.status === 403) lines.push(originHint());
    else if (e.status === 401) lines.push("The server rejected the credentials in the configured auth header.");
    return lines.join("\n");
  }
  if (e.kind === "timeout") return e.message;
  return body ? `${e.message}: ${body}` : e.message;
}

/**
 * A fetch failure's message may echo the request URL. The configured URL can
 * carry an access token in its query / userinfo, so strip those before the text
 * can reach the model, the panel or the log buffer.
 */
function redactUrl(message: string, url: string): string {
  const safe = url.replace(/\/\/[^@/]+@/, "//").split("?")[0]!.split("#")[0]!;
  return message.split(url).join(safe);
}

/** 403 guidance — MCP servers validate the request Origin; ours is the extension id. */
function originHint(): string {
  const id = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id;
  const origin = id ? `chrome-extension://${id}` : "chrome-extension://<extension-id>";
  return (
    `Pie sends requests with Origin: ${origin}. ` +
    "The server must allow that origin (e.g. OAUTH_ALLOWED_ORIGINS for workspace-mcp)."
  );
}
