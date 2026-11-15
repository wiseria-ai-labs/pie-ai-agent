import type { Entitlement } from "@/lib/managed-auth";
import { useI18n } from "@/lib/i18n";
import { MeshSparkle } from "@/sidepanel/components/MeshSparkle";

/** 与 ResearchPaywall 保持一致：未登录态展示兜底首月折扣，已登录以真实 entitlement 为准。 */
const INTRO_PERCENT_OFF_FALLBACK = 50;

const CAPS = [
  { title: "settings.memory.paywall.cap1Title", desc: "settings.memory.paywall.cap1Desc" },
  { title: "settings.memory.paywall.cap2Title", desc: "settings.memory.paywall.cap2Desc" },
  { title: "settings.memory.paywall.cap3Title", desc: "settings.memory.paywall.cap3Desc" },
] as const;

/**
 * Pie Pro 记忆订阅引导页：统一跳转到 Settings -> Models 完成登录与订阅。
 */
export default function MemoryPaywall({
  entitlement,
  onOpenSubscribe,
}: {
  entitlement: Entitlement | null;
  onOpenSubscribe?: () => void;
}) {
  const { t } = useI18n();
  const percentOff = entitlement
    ? entitlement.introOffer?.percentOff
    : INTRO_PERCENT_OFF_FALLBACK;

  return (
    <div className="flex flex-col" data-testid="memory-paywall">
      <div className="flex flex-col gap-3 pb-7">
        <div className="flex items-center gap-[7px] text-accent">
          <MeshSparkle size={13} />
          <span className="font-mono text-[10px] font-semibold leading-[14px] tracking-[0.14em]">
            PIE PRO
          </span>
        </div>
        <h2 className="text-[27px] font-semibold leading-[34px] tracking-[-0.02em] text-fg-1">
          {t("settings.memory.title")}
        </h2>
        <p className="text-[14px] leading-[22px] text-fg-2">
          {t("settings.memory.paywall.intro")}
        </p>
      </div>

      <div className="flex flex-col gap-[18px] pb-6">
        {CAPS.map((cap, i) => (
          <div key={cap.title} className="flex items-start gap-3">
            <span className="w-5 shrink-0 font-mono text-[11px] font-medium leading-[19px] text-fg-3/70">
              {`0${i + 1}`}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="text-[13px] font-medium leading-[19px] text-fg-1">
                {t(cap.title)}
              </div>
              <div className="text-[12px] leading-[18px] text-fg-2">{t(cap.desc)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          data-testid="memory-paywall-subscribe"
          onClick={() => onOpenSubscribe?.()}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-[11px] bg-fg-1 text-[14px] font-semibold text-canvas transition-transform active:scale-[0.99]"
        >
          {t("settings.memory.paywall.subscribe")}
          {percentOff != null && (
            <span className="flex items-center gap-1 rounded-full bg-canvas px-2 py-[3px] text-[10px] font-medium leading-[14px] text-fg-1">
              <MeshSparkle size={11} />
              {t("managed.subscribe.introBadge", { percentOff })}
            </span>
          )}
        </button>
        <div className="text-[12px] leading-[17px] text-fg-2">
          {t("settings.memory.paywall.quotaNote")}
        </div>
      </div>
    </div>
  );
}
