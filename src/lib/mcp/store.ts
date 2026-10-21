// MCP server configs: `mcp_servers_index` (string[]) + one `mcp_server_<id>`
// record each, in the IDB config store (same layout as custom providers).
// Header values (Authorization etc.) are encrypted with the API-key AES-GCM
// key — they are credentials just like provider API keys.

import { getConfig, removeConfig, setConfig } from "../idb/config-store";
import { decrypt, encrypt, getOrCreateEncryptionKey } from "../crypto";

const INDEX_KEY = "mcp_servers_index";
const serverKey = (id: string) => `mcp_server_${id}`;

export type McpConsentMode = "session" | "always";

export interface McpToolSummary {
  name: string;
  readOnly: boolean;
}

export interface StoredMcpServer {
  id: string;
  /** User-chosen display name; also the source of the tool-name slug. */
  name: string;
  url: string;
  enabled: boolean;
  /** "session" = ask on the first tool call per session; "always" = never ask. */
  consent: McpConsentMode;
  /** AES-GCM ciphertext of JSON `Record<string,string>`; absent = no headers. */
  encryptedHeaders?: string;
  /** Header names only — lets Settings list them without decrypting. */
  headerNames?: string[];
  /** Last successful tools/list (catalog line + count), refreshed by Test and by the agent. */
  toolsCache?: { tools: McpToolSummary[]; at: number };
  createdAt: number;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  url: string;
  enabled: boolean;
  consent: McpConsentMode;
  headers: Record<string, string>;
}

/**
 * http:// is allowed only for loopback (a local server); anything remote must
 * be https so header credentials never travel in clear text.
 */
export function validateServerUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "invalid-url" };
  }
  if (u.protocol === "https:") return { ok: true, url: u.toString() };
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return { ok: true, url: u.toString() };
  return { ok: false, error: u.protocol === "http:" ? "http-remote" : "bad-scheme" };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

export function validateHeaderName(name: string): boolean {
  // RFC 7230 token; plus we reserve the transport headers we set ourselves.
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return false;
  const lower = name.toLowerCase();
  return !["content-type", "accept", "mcp-session-id", "mcp-protocol-version"].includes(lower);
}

async function readIndex(): Promise<string[]> {
  return (await getConfig<string[]>(INDEX_KEY)) ?? [];
}

export async function listMcpServers(): Promise<StoredMcpServer[]> {
  const out: StoredMcpServer[] = [];
  for (const id of await readIndex()) {
    const s = await getConfig<StoredMcpServer>(serverKey(id));
    if (s) out.push(s);
  }
  return out;
}

export async function getMcpServer(id: string): Promise<StoredMcpServer | undefined> {
  return getConfig<StoredMcpServer>(serverKey(id));
}

export async function getMcpServerHeaders(server: StoredMcpServer): Promise<Record<string, string>> {
  if (!server.encryptedHeaders) return {};
  const key = await getOrCreateEncryptionKey();
  const parsed = JSON.parse(await decrypt(server.encryptedHeaders, key)) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
}

async function encryptHeaders(headers: Record<string, string>): Promise<Pick<StoredMcpServer, "encryptedHeaders" | "headerNames">> {
  const entries = Object.entries(headers).filter(([k]) => k.trim() !== "");
  if (entries.length === 0) return {};
  for (const [k] of entries) {
    if (!validateHeaderName(k)) throw new Error(`invalid header name: ${k}`);
  }
  const key = await getOrCreateEncryptionKey();
  return {
    encryptedHeaders: await encrypt(JSON.stringify(Object.fromEntries(entries)), key),
    headerNames: entries.map(([k]) => k),
  };
}

/** Create (no id) or update. Returns the stored record. */
export async function saveMcpServer(input: McpServerInput, id?: string): Promise<StoredMcpServer> {
  const v = validateServerUrl(input.url);
  if (!v.ok) throw new Error(v.error);
  const name = input.name.trim();
  if (!name) throw new Error("empty-name");
  const now = Date.now();
  const existing = id ? await getMcpServer(id) : undefined;
  const record: StoredMcpServer = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    url: v.url,
    enabled: input.enabled,
    consent: input.consent,
    ...(await encryptHeaders(input.headers)),
    // Keep the tools cache only if the endpoint didn't change.
    ...(existing?.toolsCache && existing.url === v.url ? { toolsCache: existing.toolsCache } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await setConfig(serverKey(record.id), record);
  const idx = await readIndex();
  if (!idx.includes(record.id)) await setConfig(INDEX_KEY, [...idx, record.id]);
  return record;
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  const s = await getMcpServer(id);
  if (!s) return;
  await setConfig(serverKey(id), { ...s, enabled, updatedAt: Date.now() });
}

/** Cache refresh — deliberately does NOT bump updatedAt (that would drop live connections). */
export async function updateMcpToolsCache(id: string, tools: McpToolSummary[]): Promise<void> {
  const s = await getMcpServer(id);
  if (!s) return;
  await setConfig(serverKey(id), { ...s, toolsCache: { tools, at: Date.now() } });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await removeConfig(serverKey(id));
  await setConfig(INDEX_KEY, (await readIndex()).filter((x) => x !== id));
}
