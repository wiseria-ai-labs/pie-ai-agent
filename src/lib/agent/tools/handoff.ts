import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { HandoffParams, HandoffResult } from "@/types/local-bridge";
import { groupAgentsByBrand, inferFormKind } from "@/lib/local-agents-prefs";

export interface HandoffBrandOption {
  id: string;
  label: string;
  forms: { id: string; kind: "app" | "terminal"; appLaunch?: HandoffResult["appLaunch"] }[];
}

export function groupHandoffBrands(
  agents: {
    id: string;
    label: string;
    kind?: "app" | "terminal";
    appLaunch?: HandoffResult["appLaunch"];
  }[],
): HandoffBrandOption[] {
  return groupAgentsByBrand(agents).map((b) => ({
    id: b.id,
    label: b.label,
    forms: b.forms.flatMap((f) => {
      const kind = inferFormKind(f.id, f.kind);
      if (!kind) return [];
      return [{ id: f.id, kind, ...(f.appLaunch ? { appLaunch: f.appLaunch } : {}) }];
    }),
  }));
}

export type HandoffAgentOption = {
  id: string;
  label: string;
  kind?: "app" | "terminal";
  appLaunch?: HandoffResult["appLaunch"];
};

export interface HandoffToolDeps {
  run: (p: HandoffParams) => Promise<HandoffResult>;
  /** 桥：本机已检测形态列表（旧 daemon 的单项降级在 local-bridge 层做）。 */
  listAgents: () => Promise<HandoffAgentOption[]>;
  /**
   * HITL 卡：用户选品牌（及可选形态）+ 授权一步完成。返回选中的形态 id，null = 拒绝。
   * target 不由 LLM 传——被 untrusted 页面驱动的 LLM 无法诱导选收件人。
   */
  requestConsent: (p: {
    context: string;
    fileCount: number;
    brands: HandoffBrandOption[];
  }) => Promise<string | null>;
}

export function buildHandoffTool(deps: HandoffToolDeps): Tool {
  return {
    name: "handoff_to_agent",
    description:
      "Hand OFF an open-ended, interactive task to a local agent installed on the user's machine " +
      "(e.g. Claude Code, Codex): ownership of the task MOVES to the local agent and the human. " +
      "FIRE-AND-FORGET: it writes your context to context.md, stages any files you provide, and opens " +
      "an interactive session (terminal or app) where the local agent continues the work WITH THE " +
      "HUMAN PRESENT. You do NOT choose the recipient — the user picks it on the authorization card. " +
      "Results are NOT returned to you. Decision rule " +
      "vs run_local_agent: hand off when the human continues the work locally and this conversation " +
      "does not need the output (open-ended / collaborative / long-running, or heavy writes in a " +
      "real project directory where a human should approve each step); use run_local_agent instead " +
      "when this conversation still needs the result and the task can run unattended in one shot. " +
      "Requires user authorization each call.",
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "A markdown brief for the local agent: what was done so far and what to continue. Written to context.md.",
        },
        files: {
          type: "array",
          description: "Optional files to stage into the handoff directory alongside context.md.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "File name (basename only; directories are stripped)." },
              content: { type: "string", description: "File content." },
            },
            required: ["name", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["context"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { context?: unknown; files?: unknown };
      if (typeof a.context !== "string" || a.context.trim() === "") {
        return { success: false, error: "handoff_to_agent: `context` is required (non-empty string)." };
      }
      const files = Array.isArray(a.files)
        ? (a.files as { name: string; content: string }[])
        : undefined;
      const agents = await deps.listAgents();
      const brands = groupHandoffBrands(agents);
      if (brands.length === 0) {
        return {
          success: false,
          error: "handoff_to_agent: no local agent is available on this machine.",
        };
      }
      const target = await deps.requestConsent({
        context: a.context,
        fileCount: files?.length ?? 0,
        brands,
      });
      if (target == null) {
        return { success: false, error: "User declined the hand-off." };
      }
      const result = await deps.run({ target, context: a.context, files });
      // fire-and-forget：无 untrusted 内容回传。observation 只报语义（谁、何种形态），
      // 不带宿主机路径（ADR 0012）。deeplink 才说 composer 已预填，回落 / Cursor 不谎称。
      const form = brands.flatMap((b) => b.forms).find((f) => f.id === target);
      const brand = brands.find((b) => b.forms.some((f) => f.id === target));
      const label = brand
        ? `${brand.label}${form ? ` (${form.kind === "app" ? "App" : "Terminal"})` : ""}`
        : (agents.find((x) => x.id === target)?.label ?? target);
      const started =
        result.mode === "app"
          ? result.appLaunch === "deeplink"
            ? `The app was opened; the composer was prefilled with a short prompt. The user must send it to start the local agent.`
            : result.appLaunch === "web"
              ? `The Web UI was opened, the handoff directory was registered as a workspace, and the brief was sent to a new session (the task is already running). If the UI is still on another workspace, choose this one to see it.`
            : `The app was opened; send a continue message in the opened app to start the local agent.`
          : `An interactive terminal session was opened and is already running.`;
      return {
        success: true,
        observation:
          `Handed off to ${label} (picked by the user). ${started}\n` +
          `This is fire-and-forget — the local agent continues independently with the user; ` +
          `results are NOT returned here.`,
      };
    },
  };
}
