import { useT } from "@/lib/i18n";
import type { McpToolConfirmRequest } from "@/lib/mcp/agent-tools";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";

interface Props {
  payload: McpToolConfirmRequest;
  onDecision: (approved: boolean) => void;
}

const PlugIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9zM12 18v3" />
  </svg>
);

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "object" && Object.keys(args as object).length === 0) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * #481 D1=A — first call of a remote MCP server's tools in this session.
 * Shows exactly which server / tool / args will be sent; approving records the
 * server for the rest of the session (ADR 0007 pattern). The approval signal
 * travels panel → SW only — never through the tool schema, so the LLM cannot
 * self-approve.
 */
export function McpToolConfirmCard({ payload, onDecision }: Props) {
  const t = useT();
  const args = formatArgs(payload.args);
  return (
    <HitlCardShell
      register="local"
      icon={<PlugIcon />}
      capsLabel={t("hitl.caps.mcpTool")}
      title={t("mcpToolConfirm.title", { server: payload.serverName })}
      description={t("mcpToolConfirm.description", { tool: payload.originalToolName })}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("mcpToolConfirm.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>
            {t("mcpToolConfirm.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("mcpToolConfirm.serverLabel")}>
          <span className="text-[12px] leading-[18px] text-fg-1">{payload.serverName}</span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("mcpToolConfirm.toolLabel")}>
          <span className="font-mono text-[12px] leading-[18px] text-fg-1 break-all">
            {payload.toolName}
          </span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("mcpToolConfirm.argsLabel")}>
          {args ? (
            <span className="whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-fg-1 break-all">
              {args}
            </span>
          ) : (
            <span className="text-[12px] leading-[18px] text-fg-3">{t("mcpToolConfirm.argsNone")}</span>
          )}
        </HitlDetailGroup>
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-2">{t("mcpToolConfirm.disclosure")}</div>
    </HitlCardShell>
  );
}
