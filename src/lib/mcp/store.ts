// Remote MCP server config storage (issue #481 §2).
//
// Lives in the IDB `config` store under one key (`mcp_servers`), written with
// setConfig so the store-bus change notification fires (the SW's connection
// cache subscribes to it). Header VALUES are AES-GCM encrypted at rest with the
// same key instances use for API keys; header KEYS stay in the clear so the
// settings page can render masked rows without decrypting.

import { getConfig, setConfig } from "@/lib/idb/config-store";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";
import { deriveSlug } from "./names";
import type { McpServerConfig } from "./types";

export const MCP_SERVERS_KEY = "mcp_servers";
export const MCP_MAX_SERVERS = 20;

export interface StoredMcpServer {
  id: string;
  name: string;
  slug: string;
  url: string;
  /** Header names only — safe to render. */
  headerKeys: string[];
  /** AES-GCM ciphertext of JSON.stringify(Record<string,string>). */
  encryptedHeaders?: string;
  createdAt: number;
}

/** Settings-page view: no secrets, display URL only. */
export interface McpServerView {
  id: string;
  name: string;
  slug: string;
  url: string;
  headerKeys: string[];
}

export type McpConfigErrorCode =
  | "nameRequired"
  | "urlInvalid"
  | "notFound"
  | "tooMany";

export class McpConfigError extends Error {
  constructor(readonly code: McpConfigErrorCode, message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https:// anywhere; http:// only loopback. */
export function validateMcpUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol === "https:") return { ok: true, url: url.toString() };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: true, url: url.toString() };
  }
  return {
    ok: false,
    reason: "URL must be https:// (http:// is only allowed for localhost / 127.0.0.1 / [::1])",
  };
}

/**
 * URL for display (settings page + anything user-visible): query, hash and
 * userinfo stripped — they may carry an access token.
 */
export function displayMcpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.split("?")[0]!.split("#")[0]!;
  }
}

async function readStored(): Promise<StoredMcpServer[]> {
  const raw = await getConfig<StoredMcpServer[]>(MCP_SERVERS_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function decryptHeaders(rec: StoredMcpServer): Promise<Record<string, string>> {
  if (!rec.encryptedHeaders) return {};
  try {
    const key = await getOrCreateEncryptionKey();
    const json = await decrypt(rec.encryptedHeaders, key);
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Key rotated / corrupt ciphertext — the server still works without headers
    // (most likely it fails auth, which the user then sees). Never throw out of
    // a list() call: one bad record must not hide every other server.
  }
  return {};
}

/** Full configs (decrypted) — SW-side only. */
export async function listMcpServers(): Promise<McpServerConfig[]> {
  const stored = await readStored();
  const out: McpServerConfig[] = [];
  for (const rec of stored) {
    out.push({
      id: rec.id,
      name: rec.name,
      slug: rec.slug,
      url: rec.url,
      createdAt: rec.createdAt,
      headers: await decryptHeaders(rec),
    });
  }
  return out;
}

/** Header-free views for the settings page. */
export async function listMcpServerViews(): Promise<McpServerView[]> {
  return (await readStored()).map(({ id, name, slug, url, headerKeys }) => ({
    id,
    name,
    slug,
    url: displayMcpUrl(url),
    headerKeys,
  }));
}

export interface McpServerInput {
  id?: string;
  name: string;
  url: string;
  /**
   * Header rows from the settings form. An empty `value` on an EXISTING key
   * keeps the stored (masked) value; new keys with an empty value are ignored.
   * Keys absent from the rows are removed.
   */
  headers: Array<{ key: string; value: string }>;
}

export async function saveMcpServer(input: McpServerInput): Promise<{ id: string; slug: string }> {
  const name = input.name.trim();
  if (!name) throw new McpConfigError("nameRequired", "Server name is required");
  const validated = validateMcpUrl(input.url);
  if (!validated.ok) throw new McpConfigError("urlInvalid", validated.reason);

  const stored = await readStored();
  const idx = input.id ? stored.findIndex((s) => s.id === input.id) : -1;
  if (input.id && idx < 0) throw new McpConfigError("notFound", "server not found");
  if (idx < 0 && stored.length >= MCP_MAX_SERVERS) {
    throw new McpConfigError("tooMany", `at most ${MCP_MAX_SERVERS} servers`);
  }
  const existing = idx >= 0 ? stored[idx] : undefined;
  const prevHeaders = existing ? await decryptHeaders(existing) : {};
  const taken = new Set(stored.filter((_, i) => i !== idx).map((s) => s.slug));

  const headers: Record<string, string> = {};
  for (const row of input.headers) {
    const key = row.key.trim();
    if (!key) continue;
    const value = row.value.length > 0 ? row.value : (prevHeaders[key] ?? "");
    if (value) headers[key] = value;
  }

  // The editor shows the display URL (query / userinfo stripped). Saving an
  // untouched field must not silently drop the stored `?token=…` — reuse the
  // old URL when origin+path match and no new query was typed.
  let urlToSave = validated.url;
  if (existing) {
    try {
      const prev = new URL(existing.url);
      const next = new URL(validated.url);
      if (
        !next.search && !next.username && !next.password &&
        prev.origin === next.origin && prev.pathname === next.pathname
      ) {
        urlToSave = existing.url;
      }
    } catch {
      // keep the validated URL
    }
  }

  const key = await getOrCreateEncryptionKey();
  const encryptedHeaders =
    Object.keys(headers).length > 0
      ? await encrypt(JSON.stringify(headers), key)
      : undefined;

  const rec: StoredMcpServer = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    slug: deriveSlug(name, taken),
    url: urlToSave,
    headerKeys: Object.keys(headers),
    ...(encryptedHeaders ? { encryptedHeaders } : {}),
    createdAt: existing?.createdAt ?? Date.now(),
  };
  const next = idx >= 0 ? stored.map((s, i) => (i === idx ? rec : s)) : [...stored, rec];
  await setConfig(MCP_SERVERS_KEY, next);
  return { id: rec.id, slug: rec.slug };
}

export async function deleteMcpServer(id: string): Promise<void> {
  const stored = await readStored();
  const next = stored.filter((s) => s.id !== id);
  if (next.length === stored.length) return;
  await setConfig(MCP_SERVERS_KEY, next);
}
