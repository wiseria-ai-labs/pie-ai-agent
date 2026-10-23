/**
 * Which tab a tool call works in, and keeping that tab rendered.
 *
 * 1. `tabId` is optional for the model on every built-in tool: the wire schema
 *    drops it from `required`, and the loop fills a missing / non-numeric
 *    `tabId` with the task's bound tab before anything reads the args.
 * 2. The tab a page tool works in is made active IN ITS OWN WINDOW
 *    (`chrome.tabs.update(id, {active:true})`). Background tabs don't render
 *    lazy-loaded SPA content (e.g. Google Classroom streams). Never touch
 *    window focus (`chrome.windows.update`) — that would yank the user across
 *    windows / workspaces.
 *
 * MCP tools are left alone: their `tabId` (if any) belongs to the server.
 */
import type { ToolDefinition } from "../model-router/types";
import type { Tool } from "./types";
import { isMcpToolName } from "../mcp/names";
import { diag, kv } from "./diag";

const TAB_ID_HINT = "Leave out for the current tab.";

type Schema = { properties?: Record<string, unknown>; required?: unknown };

/** Built-in (non-MCP) tool whose schema has a `tabId` property. */
/**
 * Tools whose tabId must stay explicit: a left-out id defaulting to the
 * current tab would do something the model didn't ask for (unpin the task's
 * own tab).
 */
const EXPLICIT_TAB_ID_TOOLS = new Set(["unpin_tab"]);

export function toolTakesTabId(tool: Pick<Tool, "name" | "parameters">): boolean {
  if (isMcpToolName(tool.name) || EXPLICIT_TAB_ID_TOOLS.has(tool.name)) return false;
  const p = tool.parameters as Schema | undefined;
  return !!p?.properties && typeof p.properties === "object" && "tabId" in p.properties;
}

/** Wire-schema copy with `tabId` optional and its description saying so. Input untouched. */
export function relaxTabIdSchema(
  name: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  if (!toolTakesTabId({ name, parameters })) return parameters;
  const p = parameters as Schema;
  const tabProp = (p.properties!.tabId ?? {}) as Record<string, unknown>;
  const desc = typeof tabProp.description === "string" ? tabProp.description : "";
  const newTabProp = /leave (it )?out/i.test(desc)
    ? tabProp
    : { ...tabProp, description: desc ? `${desc.trimEnd()} ${TAB_ID_HINT}` : TAB_ID_HINT };
  const out: Record<string, unknown> = {
    ...parameters,
    properties: { ...p.properties, tabId: newTabProp },
  };
  if (Array.isArray(p.required)) {
    const req = p.required.filter((r) => r !== "tabId");
    if (req.length > 0) out.required = req;
    else delete out.required;
  }
  return out;
}

export function toolsToWireDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: relaxTabIdSchema(t.name, t.parameters),
  }));
}

/**
 * Tools that never need the page rendered: tab/pin management (they pick
 * tabs themselves — activate_tab / switch_to_new_tab activate on their own),
 * task control, skills, schedules, files, scratchpad, local agents, search.
 * Exclusion list rather than allowlist on purpose: forgetting a non-page tool
 * here only re-activates the task's own tab (benign), while forgetting a page
 * tool in an allowlist would bring back the "background tab didn't render"
 * bug. MCP tools are skipped separately.
 */
const NO_ACTIVATION_TOOLS = new Set<string>([
  "list_tabs", "activate_tab", "close_tabs", "group_tabs", "ungroup_tabs", "move_tabs",
  "focus_tab", "open_url", "unpin_tab", "switch_to_new_tab",
  "done", "fail", "load_tools",
  "create_skill", "update_skill", "delete_skill", "list_skills",
  "use_skill", "read_skill_file", "run_skill_script", "read_skill_output",
  "create_schedule", "update_schedule", "delete_schedule", "list_schedules",
  "output_file", "read_local_file", "request_local_file",
  "save_scratchpad", "update_scratchpad_notes", "read_scratchpad", "clear_scratchpad",
  "query_scratchpad",
  "run_local_agent", "handoff_to_agent",
  "search_web",
]);

export function toolNeedsActiveTab(name: string): boolean {
  return !isMcpToolName(name) && !NO_ACTIVATION_TOOLS.has(name);
}

/**
 * Per-task activator. Re-checks `tab.active` every call (one cheap
 * chrome.tabs.get) because the user may switch tabs in that window between
 * steps; only calls tabs.update when the tab isn't active. Never throws.
 */
export function createTabActivator(sessionId: string) {
  let lastActivated: number | undefined;
  return async function ensureTabActive(tabId: number): Promise<void> {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.active) {
        lastActivated = tabId;
        return;
      }
      await chrome.tabs.update(tabId, { active: true });
      diag(
        "tab-activated",
        kv({ session: sessionId, tab: tabId, prev: lastActivated ?? "none" }),
      );
      lastActivated = tabId;
    } catch (e) {
      diag(
        "tab-activate-failed",
        kv({ session: sessionId, tab: tabId, err: e instanceof Error ? e.message : String(e) }),
      );
    }
  };
}
