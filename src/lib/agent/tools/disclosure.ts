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
 * A dynamic, run-scoped loadable group (remote MCP servers, issue #481): the
 * id + catalog line are derived from the user's configured servers at task
 * start, so the load_tools enum stays byte-stable for the whole task.
 */
export interface ExtraLoadableGroup {
  id: string;
  catalogLine: string;
  /** Connect + discover tools; resolves to a model-facing message. */
  load: () => Promise<{ ok: boolean; message: string }>;
}

export interface LoadToolsDeps {
  /** Live reference to the loop's activeToolGroups set (mutated in place). */
  getActiveGroups: () => Set<string>;
  /** Headless (scheduled) runs cannot load the schedule group. */
  headless: boolean;
  /** Dynamic groups beyond the static registry (MCP). Empty when headless. */
  extraGroups?: readonly ExtraLoadableGroup[];
}

export function buildLoadToolsTool(deps: LoadToolsDeps): Tool {
  const loadableList = LOADABLE_GROUPS.filter(
    (g) => !(deps.headless && g === "schedule"),
  );
  const extras = deps.extraGroups ?? [];
  const catalog = loadableList
    .map((g) => `${g}: ${GROUP_META[g].catalogLine}`)
    .concat(extras.map((e) => `${e.id}: ${e.catalogLine}`))
    .join("; ");
  const validList = [...loadableList, ...extras.map((e) => e.id)];
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
          items: { type: "string", enum: validList },
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
            validList.join(", ") + ".",
          error: "missingGroups",
        };
      }
      const active = deps.getActiveGroups();
      const extraById = new Map(extras.map((e) => [e.id, e]));
      // Trim before matching, like resolveLoadTools does for static groups.
      const requested = groups.map((g) => g.trim());
      const staticGroups = requested.filter((g) => !extraById.has(g));
      const extraIds = requested.filter((g) => extraById.has(g));
      const r = resolveLoadTools(staticGroups, active, { headless: deps.headless });
      const lines: string[] = [];
      if (r.loaded.length) {
        const notice = buildActivationNotice(r.loaded as DisclosureGroup[]);
        if (notice) lines.push(notice);
      }
      // Dynamic groups — connect / discover, only light up on success.
      let extraLoaded = 0;
      for (const id of extraIds) {
        const extra = extraById.get(id)!;
        if (active.has(id)) {
          r.alreadyActive.push(id);
          continue;
        }
        const res = await extra.load();
        lines.push(res.message);
        if (res.ok) {
          active.add(id);
          extraLoaded++;
        }
      }
      if (r.alreadyActive.length) {
        lines.push(`Already active: ${r.alreadyActive.join(", ")}.`);
      }
      if (r.unknown.length) {
        lines.push(
          `Unknown / not loadable: ${r.unknown.join(", ")}. Valid groups: ` +
            validList.join(", ") + ".",
        );
      }
      return {
        success: r.loaded.length > 0 || extraLoaded > 0 || r.alreadyActive.length > 0,
        observation: lines.join("\n\n"),
      };
    },
  };
}
