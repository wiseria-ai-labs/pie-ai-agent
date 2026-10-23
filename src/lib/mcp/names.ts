// Provider-safe names for MCP tools.
//
// Every LLM provider we route to accepts tool names matching
// ^[a-zA-Z0-9_-]{1,64}$ (the strictest common denominator — OpenAI and
// Anthropic both cap at 64). MCP tool names are free-form, so we expose
// `mcp__<server>__<tool>` sanitized to that alphabet and keep a reverse map
// back to the server's real tool name for tools/call.

export const MAX_TOOL_NAME_LENGTH = 64;
const MAX_SLUG_LENGTH = 16;
export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_GROUP_PREFIX = "mcp:";

/** FNV-1a 32-bit → 6 hex chars. Stable, dependency-free disambiguator. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function clean(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Slugs never contain "__" and never start/end with "_": the first "__" after
 * `mcp__` then always marks the slug/tool boundary, so two servers can never
 * produce the same exposed name (server "a" + tool "b__c" vs server "a__b" +
 * tool "c" would both be `mcp__a__b__c`).
 */
function slugSafe(s: string): string {
  return s.replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

/** Server display name → short identifier used in tool and group names. */
export function serverSlug(name: string, id: string): string {
  const base = slugSafe(slugSafe(clean(name.toLowerCase())).slice(0, MAX_SLUG_LENGTH));
  return base || `s${shortHash(id)}`;
}

/**
 * Give every server a unique slug. Collisions (two servers named "docs") get
 * a hash of the server id appended, so slugs stay stable as servers are added.
 */
export function assignServerSlugs(
  servers: ReadonlyArray<{ id: string; name: string }>,
): Map<string, string> {
  const raw = servers.map((s) => ({ id: s.id, slug: serverSlug(s.name, s.id) }));
  const counts = new Map<string, number>();
  for (const r of raw) counts.set(r.slug, (counts.get(r.slug) ?? 0) + 1);
  const out = new Map<string, string>();
  const used = new Set(raw.filter((r) => counts.get(r.slug) === 1).map((r) => r.slug));
  for (const r of raw) {
    if (counts.get(r.slug) === 1) {
      out.set(r.id, r.slug);
      continue;
    }
    // Disambiguate; also never land on another server's natural slug.
    const head = slugSafe(r.slug.slice(0, MAX_SLUG_LENGTH - 7));
    let slug = slugSafe(`${head}_${shortHash(r.id)}`);
    for (let n = 1; used.has(slug); n++) slug = slugSafe(`${head}_${shortHash(`${r.id}#${n}`)}`);
    used.add(slug);
    out.set(r.id, slug);
  }
  return out;
}

export function mcpGroupId(slug: string): string {
  return `${MCP_GROUP_PREFIX}${slug}`;
}

export function isMcpGroupId(group: string): boolean {
  return group.startsWith(MCP_GROUP_PREFIX);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export interface McpNameEntry {
  exposedName: string;
  toolName: string;
}

/**
 * Map one server's tool names to exposed names. Over-long names are truncated
 * with a hash suffix; names that collide after sanitizing are disambiguated
 * the same way. Returns entries in input order.
 */
export function exposeToolNames(slug: string, toolNames: readonly string[]): McpNameEntry[] {
  const prefix = `${MCP_TOOL_PREFIX}${slug}__`;
  const room = MAX_TOOL_NAME_LENGTH - prefix.length;
  const used = new Set<string>();
  const out: McpNameEntry[] = [];
  for (const toolName of toolNames) {
    let part = clean(toolName) || "tool";
    if (part.length > room || used.has(prefix + part)) {
      part = `${part.slice(0, room - 7)}_${shortHash(toolName)}`;
    }
    let exposed = prefix + part;
    // A hash collision after truncation is astronomically unlikely; still never emit a duplicate.
    for (let n = 2; used.has(exposed); n++) exposed = `${prefix}${part.slice(0, room - 3)}_${n}`;
    used.add(exposed);
    out.push({ exposedName: exposed, toolName });
  }
  return out;
}

export const PROVIDER_SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
