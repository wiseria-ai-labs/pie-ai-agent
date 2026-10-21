import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import {
  resolveLoadTools,
  buildActivationNotice,
  LOADABLE_GROUPS,
  GROUP_META,
} from "../disclosure";
import type { DisclosureGroup } from "../tool-names";

/**
 * A tool group defined at runtime (one per enabled MCP server). `activate`
 * runs when load_tools arms it — it connects and lists tools, so a dead
 * server is reported immediately instead of silently yielding no tools.
 */
export interface ExtraToolGroup {
  id: string;
  catalogLine: string;
  activate: () => Promise<{ ok: true; notice: string } | { ok: false; error: string }>;
}

export interface LoadToolsDeps {
  /** Live reference to the loop's activeToolGroups set (mutated in place). */
  getActiveGroups: () => Set<string>;
  /** Headless (scheduled) runs cannot load the schedule group. */
  headless: boolean;
  extraGroups?: readonly ExtraToolGroup[];
}

export function buildLoadToolsTool(deps: LoadToolsDeps): Tool {
  const loadableList = LOADABLE_GROUPS.filter(
    (g) => !(deps.headless && g === "schedule"),
  );
  const extraGroups = deps.extraGroups ?? [];
  const extraById = new Map(extraGroups.map((g) => [g.id, g]));
  const groupIds: string[] = [...loadableList, ...extraGroups.map((g) => g.id)];
  const catalog = [
    ...loadableList.map((g) => `${g}: ${GROUP_META[g].catalogLine}`),
    ...extraGroups.map((g) => g.catalogLine),
  ].join("; ");
  return {
    name: "load_tools",
    description:
      "Load an on-demand tool group so its tools become callable next turn. " +
      "Use when the task needs a capability not in your current tool set. " +
      `Loadable groups — ${catalog}.`,
    parameters: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: { type: "string", enum: groupIds },
          description: 'Group ids to load (e.g. ["pdf"], ["scratchpad"]).',
        },
      },
      required: ["groups"],
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { groups?: unknown };
      const groups = Array.isArray(a.groups) ? a.groups.map(String) : [];
      if (groups.length === 0) {
        return {
          success: false,
          observation:
            "load_tools: `groups` is required (non-empty array). Valid groups: " +
            groupIds.join(", ") + ".",
          error: "missingGroups",
        };
      }
      const active = deps.getActiveGroups();
      const r = resolveLoadTools(groups, active, {
        headless: deps.headless,
        extraLoadable: new Set(extraById.keys()),
      });
      const lines: string[] = [];
      const builtinLoaded = r.loaded.filter((g) => !extraById.has(g));
      if (builtinLoaded.length) {
        const notice = buildActivationNotice(builtinLoaded as DisclosureGroup[]);
        if (notice) lines.push(notice);
      }
      let extraLoaded = 0;
      for (const g of r.loaded.filter((id) => extraById.has(id))) {
        const outcome = await extraById.get(g)!.activate();
        if (outcome.ok) {
          extraLoaded++;
          lines.push(outcome.notice);
        } else {
          // Don't leave a dead group armed — it would contribute no tools.
          active.delete(g);
          lines.push(`Could not load ${g}: ${outcome.error}`);
        }
      }
      if (r.alreadyActive.length) {
        lines.push(`Already active: ${r.alreadyActive.join(", ")}.`);
      }
      if (r.unknown.length) {
        lines.push(
          `Unknown / not loadable: ${r.unknown.join(", ")}. Valid groups: ` +
            groupIds.join(", ") + ".",
        );
      }
      return {
        success: builtinLoaded.length + extraLoaded > 0 || r.alreadyActive.length > 0,
        observation: lines.join("\n\n"),
      };
    },
  };
}
