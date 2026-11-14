// MCP → agent tool bridge (issue #481 §4 / §7).
//
// One server = one disclosure group (`mcp:<slug>`) = a bag of tools named
// `mcp_<slug>_<tool>`. Tools are only in the agent's tool array once the group
// is active. Every call is confirmed once per session × server (D1=A), and the
// result is fed back to the model inside `<untrusted_mcp_result>` — server text
// is third-party input, exactly like page content.
//
// Dispatch never parses an exposed name back into {server, tool}: each handler
// closure captures the live server + the tool's ORIGINAL name, so a lossy
// sanitized/truncated name cannot misroute a call.
//
// `planMcpTools` is the pure half (sanitize + name); `buildMcpTools` wraps the
// plan in handlers. The settings-page "test connection" uses the plan only.

import type { Tool } from "../agent/types";
import type { ActionResult } from "../dom-actions/types";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "../agent/untrusted-wrappers";
import { describeMcpError } from "./client";
import { connectMcpServer, type LiveMcpServer } from "./connection";
import { exposedMcpToolName, isMcpGroupId, mcpGroupId } from "./names";
import { MCP_DESCRIPTION_MAX_CHARS, sanitizeInputSchema } from "./schema";
import type { McpServerConfig, McpToolCallResult, McpToolDef } from "./types";

export const MCP_RESULT_MAX_CHARS = 16_000;
export const MCP_ERROR_MAX_CHARS = 800;

/** Confirm-card payload. Args are shown verbatim — the approval signal comes
 *  from the panel, never from tool args (the LLM cannot self-approve). */
export interface McpToolConfirmRequest {
  serverId: string;
  serverName: string;
  /** Exposed tool name (`mcp_<slug>_<tool>`). */
  toolName: string;
  /** Tool name as the server declared it. */
  originalToolName: string;
  args: unknown;
}

export interface McpToolsDeps {
  callTool: (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCallResult>;
  confirm: (p: McpToolConfirmRequest) => Promise<boolean>;
  signal: AbortSignal;
}

export interface McpSkippedTool {
  name: string;
  reason: string;
}

/** One tool, sanitized and named, with no behavior attached. */
export interface McpPlannedTool {
  exposed: string;
  def: McpToolDef;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpToolPlan {
  entries: McpPlannedTool[];
  /** Tools the sanitizer refused (readable reason; the server stays usable). */
  skipped: McpSkippedTool[];
}

/** Wrap server-provided text as untrusted input (escape + truncate). */
export function wrapMcpResult(
  serverName: string,
  toolName: string,
  body: string,
  maxChars = MCP_RESULT_MAX_CHARS,
): string {
  const text = escapeUntrustedWrappers(body).slice(0, maxChars);
  return (
    `<untrusted_mcp_result server="${escapeWrapperAttribute(serverName)}" ` +
    `tool="${escapeWrapperAttribute(toolName)}">\n${text}\n</untrusted_mcp_result>`
  );
}

function renderContent(res: McpToolCallResult): string {
  const parts: string[] = [];
  for (const item of res.content ?? []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push(`[image content omitted (${item.mimeType ?? "image"}) — this build only passes text to the model]`);
    } else if (item.type === "resource") {
      parts.push("[embedded resource omitted — this build only passes text to the model]");
    } else {
      parts.push(`[${String(item.type ?? "unknown")} content omitted]`);
    }
  }
  return parts.join("\n") || "(empty result)";
}

/**
 * Sanitize + name every tool the server advertises. Deterministic: server
 * order in, `tools/list` order out. Pure (no I/O, no handlers).
 */
export function planMcpTools(live: Pick<LiveMcpServer, "name" | "slug" | "tools">): McpToolPlan {
  const entries: McpPlannedTool[] = [];
  const skipped: McpSkippedTool[] = [];
  const taken = new Set<string>();

  for (const def of live.tools as McpToolDef[]) {
    const sanitized = sanitizeInputSchema(def.inputSchema);
    if (!sanitized.ok) {
      skipped.push({ name: def.name, reason: sanitized.reason });
      continue;
    }
    const exposed = exposedMcpToolName(live.slug, def.name, taken);
    taken.add(exposed);
    const rawDesc = typeof def.description === "string" ? def.description.trim() : "";
    const description =
      `[MCP server "${live.name}"] ` +
      (rawDesc.length > MCP_DESCRIPTION_MAX_CHARS
        ? rawDesc.slice(0, MCP_DESCRIPTION_MAX_CHARS) + "…"
        : rawDesc || `Tool "${def.name}" on the user's MCP server.`);
    entries.push({ exposed, def, description, parameters: sanitized.schema });
  }
  return { entries, skipped };
}

/**
 * Turn one server's advertised tools into agent tools (plan + handlers). The
 * group is set explicitly: `getToolGroup` falls back to "core" for unknown
 * names, which would keep un-activated MCP tools visible on every turn.
 */
export function buildMcpTools(live: LiveMcpServer, deps: McpToolsDeps): { tools: Tool[]; skipped: McpSkippedTool[] } {
  const plan = planMcpTools(live);
  const group = mcpGroupId(live.slug);
  const tools = plan.entries.map(({ exposed, def, description, parameters }): Tool => ({
    name: exposed,
    description,
    parameters,
    group,
    handler: async (args: unknown): Promise<ActionResult> => {
      const approved = await deps.confirm({
        serverId: live.serverId,
        serverName: live.name,
        toolName: exposed,
        originalToolName: def.name,
        args,
      });
      if (!approved) {
        return {
          success: false,
          observation: `MCP tool "${exposed}" was denied by the user.`,
          error: "denied",
        };
      }
      try {
        // Closed-over ORIGINAL name — never parsed back out of `exposed`.
        const res = await deps.callTool(def.name, (args ?? {}) as Record<string, unknown>, deps.signal);
        const wrapped = wrapMcpResult(live.name, def.name, renderContent(res));
        return res.isError
          ? { success: false, observation: wrapped, error: "toolError" }
          : { success: true, observation: wrapped };
      } catch (e) {
        const msg = describeMcpError(e).slice(0, MCP_ERROR_MAX_CHARS);
        return {
          success: false,
          observation: wrapMcpResult(live.name, def.name, `MCP tool call failed: ${msg}`),
          error: "mcpError",
        };
      }
    },
  }));
  return { tools, skipped: plan.skipped };
}

export interface McpActivateResult {
  ok: boolean;
  tools: Tool[];
  skipped: McpSkippedTool[];
  /** Readable message for load_tools / settings (may contain untrusted server text). */
  message: string;
}

/**
 * Connect (or reuse the cached connection) and build this server's tools.
 * Never throws — a broken server yields `{ok:false, message}` so the caller can
 * report it without activating the group. `deps.signal` only aborts THIS
 * caller's wait for the shared handshake.
 */
export async function activateMcpServer(
  cfg: McpServerConfig,
  deps: McpToolsDeps,
): Promise<McpActivateResult> {
  try {
    const live = await connectMcpServer(cfg, { signal: deps.signal });
    const built = buildMcpTools(live, deps);
    const names = built.tools.map((t) => t.name);
    const lines = [
      names.length
        ? `MCP server "${cfg.name}" connected. Now available: ${names.join(", ")}.`
        : `MCP server "${cfg.name}" connected but advertises no usable tools.`,
    ];
    if (built.skipped.length) {
      lines.push(
        `Skipped tools: ${built.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.`,
      );
    }
    return { ok: true, tools: built.tools, skipped: built.skipped, message: lines.join("\n") };
  } catch (e) {
    return {
      ok: false,
      tools: [],
      skipped: [],
      message: `MCP server "${cfg.name}" is unreachable: ${describeMcpError(e).slice(0, MCP_ERROR_MAX_CHARS)}`,
    };
  }
}

/**
 * Per-session × per-server approval closure (mirrors makeSessionSkillConfirm —
 * ADR 0007 pattern). Approved once → the rest of the session skips the card.
 */
export function makeSessionMcpConfirm(deps: {
  isApproved: (serverId: string) => Promise<boolean>;
  requestConfirm: (p: McpToolConfirmRequest) => Promise<boolean>;
  record: (serverId: string) => Promise<void>;
}): (p: McpToolConfirmRequest) => Promise<boolean> {
  return async (p) => {
    if (await deps.isApproved(p.serverId)) return true;
    const approved = await deps.requestConfirm(p);
    if (approved) await deps.record(p.serverId);
    return approved;
  };
}

/**
 * Resume helper (pure over the active set): reconnect every `mcp:*` group the
 * prior run had activated — in parallel, so N servers don't serialize their
 * handshakes. Groups whose server is gone / unreachable are dropped from
 * `active` and returned so the caller can tell the model.
 */
export async function restoreMcpGroups(
  active: Set<string>,
  activate: (group: string) => Promise<{ ok: boolean }>,
): Promise<string[]> {
  const groups = [...active].filter(isMcpGroupId);
  const results = await Promise.all(groups.map(async (group) => ({ group, ok: (await activate(group)).ok })));
  const dropped: string[] = [];
  for (const { group, ok } of results) {
    if (!ok) {
      active.delete(group);
      dropped.push(group);
    }
  }
  return dropped;
}

/** Headless runs expose no MCP groups at all (nobody can answer the confirm card). */
export function dropMcpGroups(active: Set<string>): void {
  for (const group of [...active]) {
    if (isMcpGroupId(group)) active.delete(group);
  }
}
