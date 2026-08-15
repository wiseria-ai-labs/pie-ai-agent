import { useT } from "@/lib/i18n";
import type { SkillRunConfirmRequest } from "@/lib/agent/tools/skill-script";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";

interface Props {
  payload: SkillRunConfirmRequest;
  onDecision: (approved: boolean) => void;
}

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
  </svg>
);

/**
 * skill 运行确认卡（ADR 0007，取代信封授权卡）：展示这次要跑哪个 skill 的哪个脚本、
 * 带什么参数（args 全文），内容不经 LLM 转述。批准粒度 = per session ×
 * per skill——同会话再调同一 skill 不再弹卡（记录随 session 持久化）。
 */
export function SkillRunConfirmCard({ payload, onDecision }: Props) {
  const t = useT();
  const args = payload.args ?? [];

  return (
    <HitlCardShell
      register="local"
      icon={<ShieldIcon />}
      capsLabel={t("hitl.caps.skillRunConfirm")}
      title={t("skillRunConfirm.title", { name: payload.skillName })}
      description={payload.description}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("skillRunConfirm.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>
            {t("skillRunConfirm.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("skillRunConfirm.entryLabel")}>
          <span className="font-mono text-[12px] leading-[18px] text-fg-1">{payload.entry}</span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("skillRunConfirm.argsLabel")}>
          {args.length > 0 ? (
            args.map((arg, i) => (
              <span
                key={i}
                className="font-mono text-[12px] leading-[18px] text-fg-1 break-all"
              >
                {arg}
              </span>
            ))
          ) : (
            <span className="text-[12px] leading-[18px] text-fg-3">{t("skillRunConfirm.argsNone")}</span>
          )}
        </HitlDetailGroup>
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-2">{t("skillRunConfirm.disclosure")}</div>
    </HitlCardShell>
  );
}
