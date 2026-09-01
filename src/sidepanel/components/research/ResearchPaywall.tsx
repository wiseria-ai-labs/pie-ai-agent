import type { Entitlement } from "@/lib/managed-auth";
import { useI18n } from "@/lib/i18n";
import { MeshSparkle } from "../MeshSparkle";

/**
 * Shown when we have no entitlement to ask — i.e. the signed-out visitor this
 * page mostly serves. Keep in sync with the Stripe coupon; a signed-in user's
 * real introOffer always wins, and its absence means the backend said they are
 * not eligible, so we show nothing rather than a promise we can't keep.
 */
const INTRO_PERCENT_OFF_FALLBACK = 50;

const CAPS = [
  { title: "research.paywall.cap1Title", desc: "research.paywall.cap1Desc" },
  { title: "research.paywall.cap2Title", desc: "research.paywall.cap2Desc" },
  { title: "research.paywall.cap3Title", desc: "research.paywall.cap3Desc" },
] as const;

/**
 * Sign-in and subscription live in one place only: Settings → Models → the
 * official-subscription provider. This page just routes there. Signing in from
 * here used to leave the account without a provider instance — unlocked page,
 * no key to run with.
 */
export default function ResearchPaywall({
  entitlement,
  onOpenSubscribe,
}: {
  entitlement: Entitlement | null;
  onOpenSubscribe: () => void;
}) {
  const { t } = useI18n();
  const percentOff = entitlement
    ? entitlement.introOffer?.percentOff
    : INTRO_PERCENT_OFF_FALLBACK;

  return (
    <div className="flex flex-col" data-testid="research-paywall">
      <div className="flex flex-col gap-3 pb-7">
        <div className="flex items-center gap-[7px] text-accent">
          <MeshSparkle size={13} />
          <span className="font-mono text-[10px] font-semibold leading-[14px] tracking-[0.14em]">
            PIE PRO
          </span>
        </div>
        <h2 className="text-[27px] font-semibold leading-[34px] tracking-[-0.02em] text-fg-1">
          {t("research.title")}
        </h2>
        <p className="text-[14px] leading-[22px] text-fg-2">{t("research.paywall.intro")}</p>
      </div>

      <div className="flex flex-col gap-[18px] pb-6">
        {CAPS.map((cap, i) => (
          <div key={cap.title} className="flex items-start gap-3">
            <span className="w-5 shrink-0 font-mono text-[11px] font-medium leading-[19px] text-fg-3/70">
              {`0${i + 1}`}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="text-[13px] font-medium leading-[19px] text-fg-1">{t(cap.title)}</div>
              <div className="text-[12px] leading-[18px] text-fg-2">{t(cap.desc)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          data-testid="research-paywall-subscribe"
          onClick={onOpenSubscribe}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-[11px] bg-fg-1 text-[14px] font-semibold text-canvas transition-transform active:scale-[0.99]"
        >
          {t("research.paywall.subscribe")}
          {percentOff != null && (
            <span className="flex items-center gap-1 rounded-full bg-canvas px-2 py-[3px] text-[10px] font-medium leading-[14px] text-fg-1">
              <MeshSparkle size={11} />
              {t("managed.subscribe.introBadge", { percentOff })}
            </span>
          )}
        </button>
        <div className="text-[12px] leading-[17px] text-fg-2">{t("research.paywall.quotaNote")}</div>
      </div>
    </div>
  );
}
