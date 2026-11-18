import { useT } from "@/lib/i18n";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./HitlCardShell";

interface Props {
  payload: unknown;
  /** true = 只允许本次会话把加密条目的正文发给模型。 */
  onDecision: (allowed: boolean) => void;
}

const LockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 1 1 8 0v3" />
  </svg>
);

/**
 * 加密记忆（地址 / 联系方式）的放行卡。Pie 默认只把这类条目的占位行给模型，
 * 模型确实需要正文时才弹这张卡；拒绝就继续隐藏，模型照常回答。
 */
export function MemoryUnlockCard({ payload, onDecision }: Props) {
  const t = useT();
  const p = (payload ?? {}) as { count?: unknown };
  const count = typeof p.count === "number" && p.count > 0 ? p.count : 1;
  return (
    <HitlCardShell
      register="browser"
      icon={<LockIcon />}
      capsLabel={t("hitl.caps.memoryUnlock")}
      title={t("memoryUnlock.title")}
      description={t("memoryUnlock.body", { count })}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("memoryUnlock.decline")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="browser" onClick={() => onDecision(true)}>
            {t("memoryUnlock.allow")}
          </HitlPrimaryButton>
        </>
      }
    />
  );
}
