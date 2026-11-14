// Remote MCP (Model Context Protocol) support — shared types.
//
// Transport: MCP Streamable HTTP (client side, extension SW). Config lives in
// IDB; the client speaks JSON-RPC 2.0 over POST. See
// docs/adr/0014-remote-mcp-servers.md for the landing decisions.

/** Decrypted, in-memory view of one configured server. */
export interface McpServerConfig {
  id: string;
  /** User-provided display name (untrusted for prompt purposes, trusted as config). */
  name: string;
  /** ASCII slug derived from `name`; unique across servers. Namespaces tools + groups. */
  slug: string;
  /** Full URL as configured (may carry a query token — never show it to the model). */
  url: string;
  /** Auth headers, decrypted. Never logged, never sent to the model. */
  headers: Record<string, string>;
  createdAt: number;
}

/** One tool advertised by a server's `tools/list`. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpContentItem {
  type?: string;
  text?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface McpToolCallResult {
  content?: McpContentItem[];
  isError?: boolean;
  [k: string]: unknown;
}
