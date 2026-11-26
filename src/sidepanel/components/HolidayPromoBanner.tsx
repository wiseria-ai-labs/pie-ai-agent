import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Sparkles, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  HOLIDAY_SALE_CODE,
  buildHolidaySaleUrl,
} from "@/lib/holiday-sale";

async function copyPromoCode(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy textarea copy fallback.
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function HolidayCodePill({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    const ok = await copyPromoCode(HOLIDAY_SALE_CODE);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      data-testid="holiday-code-copy"
      aria-label={t("holidaySale.copyCodeAria", { code: HOLIDAY_SALE_CODE })}
      onClick={() => void handleCopy()}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-chip border border-warning-line bg-surface font-mono transition-colors hover:bg-field ${
        compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[11.5px]"
      }`}
    >
      <span className="font-semibold tracking-[0.06em] text-fg-1">{HOLIDAY_SALE_CODE}</span>
      <span className="h-3 w-px bg-line" aria-hidden="true" />
      <span className="inline-flex items-center gap-1 font-sans text-[11px] font-medium text-warning">
        {copied ? (
          <>
            <Check size={11} strokeWidth={2.2} aria-hidden="true" />
            {t("holidaySale.copied")}
          </>
        ) : (
          <>
            <Copy size={11} strokeWidth={1.9} aria-hidden="true" />
            {t("holidaySale.copy")}
          </>
        )}
      </span>
    </button>
  );
}

export interface HolidayPromoBannerProps {
  variant: "home" | "compact";
  description?: string;
  ctaLabel?: string;
  onCta?: () => void;
  ctaDisabled?: boolean;
  showDetailsLink?: boolean;
  onDismiss?: () => void;
  testId?: string;
}

export default function HolidayPromoBanner({
  variant,
  description,
  ctaLabel,
  onCta,
  ctaDisabled = false,
  showDetailsLink = false,
  onDismiss,
  testId = "holiday-promo-banner",
}: HolidayPromoBannerProps) {
  const { t, locale } = useI18n();
  const detailsUrl = buildHolidaySaleUrl(locale);

  if (variant === "home") {
    return (
      <div
        data-testid={testId}
        className="flex w-full flex-col gap-2.5 rounded-card border border-warning-line bg-warning-tint p-3.5 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-warning-line bg-surface px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] text-warning">
            <Sparkles size={11} strokeWidth={2} aria-hidden="true" />
            {t("holidaySale.badge")}
          </span>
          {onDismiss && (
            <button
              type="button"
              data-testid="holiday-promo-dismiss"
              aria-label={t("common.dismiss")}
              onClick={onDismiss}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-chip text-fg-3 transition-colors hover:bg-surface hover:text-fg-1"
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-[13px] font-semibold leading-[18px] text-fg-1">
            {t("holidaySale.homeTitle")}
          </div>
          <p className="text-[12px] leading-[17px] text-fg-2">
            {description ?? t("holidaySale.homeDesc")}
          </p>
        </div>

        <div className="flex items-center">
          <HolidayCodePill />
        </div>

        {(onCta || showDetailsLink) && (
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            {onCta && ctaLabel && (
              <button
                type="button"
                data-testid="holiday-promo-cta"
                disabled={ctaDisabled}
                onClick={onCta}
                className="rounded-control bg-fg-1 px-3 py-1.5 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {ctaLabel}
              </button>
            )}
            {showDetailsLink && (
              <a
                href={detailsUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="holiday-promo-details"
                className="inline-flex items-center gap-0.5 text-[12px] text-fg-2 underline underline-offset-2 hover:text-fg-1"
              >
                {t("holidaySale.viewDetails")}
                <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={testId}
      className="flex w-full flex-col gap-2 rounded-card border border-warning-line bg-warning-tint px-3 py-2.5 text-left"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold tracking-[0.04em] text-warning">
          <Sparkles size={11} strokeWidth={2} aria-hidden="true" />
          {t("holidaySale.compactBadge")}
        </span>
        <HolidayCodePill compact />
      </div>

      <p className="text-[12px] leading-[17px] text-fg-2">
        {description ?? t("holidaySale.settingsDesc", { code: HOLIDAY_SALE_CODE })}
      </p>

      {(onCta || showDetailsLink) && (
        <div className="flex flex-wrap items-center gap-3 pt-0.5">
          {onCta && ctaLabel && (
            <button
              type="button"
              data-testid="holiday-promo-cta"
              disabled={ctaDisabled}
              onClick={onCta}
              className="rounded-control bg-fg-1 px-2.5 py-1.5 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {ctaLabel}
            </button>
          )}
          {showDetailsLink && (
            <a
              href={detailsUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="holiday-promo-details"
              className="inline-flex items-center gap-0.5 text-[12px] text-fg-2 underline underline-offset-2 hover:text-fg-1"
            >
              {t("holidaySale.viewDetails")}
              <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function HolidayCheckoutCodeCallout() {
  const { t } = useI18n();
  return (
    <div
      data-testid="holiday-checkout-code-callout"
      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-warning-line bg-warning-tint px-3 py-2"
    >
      <span className="flex-1 text-[11.5px] leading-[16px] text-fg-1">
        {t("holidaySale.checkoutHint", { code: HOLIDAY_SALE_CODE })}
      </span>
      <HolidayCodePill compact />
    </div>
  );
}
