import { useT } from "@/lib/i18n";
import type { McpConsentRequest } from "@/lib/mcp/tools";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";

interface Props {
  payload: McpConsentRequest;
  onDecision: (approved: boolean) => void;
}

const PlugIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4" />
  </svg>
);

/**
 * MCP consent card — first call to a server's tools in a session (servers set
 * to "Ask once per session"). Shows the exact tool + arguments that will be
 * sent; approval covers this server for the rest of the session.
 */
export function McpToolConsentCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="local"
      icon={<PlugIcon />}
      capsLabel={t("hitl.caps.mcp")}
      title={t("mcpConsent.title", { server: payload.serverName })}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>{t("mcpConsent.deny")}</HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>
            {t("mcpConsent.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("mcpConsent.toolLabel")}>
          <span className="font-mono text-[12px] leading-[18px] text-fg-1">
            {payload.toolName}
            {payload.readOnly ? ` · ${t("mcpConsent.readOnly")}` : ""}
          </span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("mcpConsent.argsLabel")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] text-fg-1">
            {payload.argsPreview}
          </pre>
        </HitlDetailGroup>
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-2">
        {t("mcpConsent.disclosure", { url: payload.serverUrl })}
      </div>
    </HitlCardShell>
  );
}
