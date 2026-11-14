// Naming for remote MCP servers (issue #481).
//
// Two names matter per server:
//   - slug  — ASCII namespace derived from the user's display name, unique per
//     server (validated at save time). Used for the disclosure group id
//     (`mcp:<slug>`) and as the tool-name namespace.
//   - tool name — `mcp_<slug>_<tool>`, constrained to the intersection of what
//     OpenAI / Gemini / Anthropic accept: `[a-zA-Z0-9_-]`, ≤ 64 chars, starts
//     with a letter (the `mcp_` prefix guarantees the last one).
//
// Dispatch is a lookup table (`exposed name → {serverId, original tool name}`),
// built once from the server's tool list — names are NEVER parsed back into
// server/tool (a sanitized name is lossy).

const MAX_TOOL_NAME = 64;
const MAX_SLUG = 24;

/** FNV-1a 32-bit — tiny, deterministic, good enough for name disambiguation. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `[a-zA-Z0-9_-]` only; everything else collapses to a single `_`. */
export function sanitizeNamePart(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Derive a slug from the server's display name. Non-ASCII names (e.g. Chinese)
 * sanitize to nothing, so they fall back to `srv-<hash>`. Collisions with an
 * already-taken slug get a `-<hash>` suffix (still deterministic).
 */
export function deriveSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  let slug = base || `srv-${hash(name).slice(0, 6)}`;
  if (!taken.has(slug)) return slug;
  slug = `${slug.slice(0, MAX_SLUG - 7)}-${hash(name).slice(0, 6)}`;
  let n = 2;
  while (taken.has(slug)) slug = `${base || "srv"}-${hash(`${name}:${n++}`).slice(0, 6)}`;
  return slug;
}

export function mcpGroupId(slug: string): string {
  return `mcp:${slug}`;
}

export function isMcpGroupId(group: string): boolean {
  return group.startsWith("mcp:") && group.length > 4;
}

export function mcpSlugFromGroup(group: string): string | null {
  return isMcpGroupId(group) ? group.slice(4) : null;
}

/**
 * Exposed tool name for one server tool. Truncation keeps a short hash so two
 * long names that truncate to the same prefix still differ. `taken` is the
 * per-server set used to de-duplicate post-sanitization collisions
 * (`a.b` vs `a_b`).
 */
export function exposedMcpToolName(
  slug: string,
  toolName: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const prefix = `mcp_${slug}_`;
  const part = sanitizeNamePart(toolName) || `t_${hash(toolName).slice(0, 6)}`;
  let name = prefix + part;
  if (name.length > MAX_TOOL_NAME) {
    const keep = MAX_TOOL_NAME - prefix.length - 7;
    name = `${prefix}${part.slice(0, Math.max(1, keep))}_${hash(toolName).slice(0, 6)}`;
  }
  if (!taken.has(name)) return name;
  // Same server, two tool names that sanitized identically: hash-suffix loop.
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, MAX_TOOL_NAME - 7)}_${hash(`${toolName}:${n}`).slice(0, 6)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `exposed name → whose tool is it` — the only dispatch mechanism. */
export interface McpToolRef {
  serverId: string;
  toolName: string;
}

/**
 * Build the reverse-lookup table for a set of servers. Deterministic: servers in
 * the given order, tools in each server's advertised order.
 */
export function buildMcpDispatch(
  servers: ReadonlyArray<{ id: string; slug: string; tools: ReadonlyArray<{ name: string }> }>,
): Map<string, McpToolRef> {
  const table = new Map<string, McpToolRef>();
  for (const server of servers) {
    const taken = new Set<string>();
    for (const tool of server.tools) {
      const exposed = exposedMcpToolName(server.slug, tool.name, taken);
      taken.add(exposed);
      table.set(exposed, { serverId: server.id, toolName: tool.name });
    }
  }
  return table;
}

/**
 * One line in `<available_tools_catalog>` for a server group. Only the
 * user-provided name is included (no URL, no server-provided text).
 */
export function mcpCatalogLine(name: string): string {
  return (
    `${name}（用户接入的外部服务；需要操作该服务时优先用它的工具，` +
    `不要去点该服务的网页 UI）`
  );
}
