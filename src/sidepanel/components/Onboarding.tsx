/**
 * Onboarding — spec §6 I 屏 (first-run), F8 minimal-faithful landing.
 *
 * Full-screen overlay shown over the agent view on first run: hero mark,
 * an intro headline, two entry cards (managed subscribe / BYOK), and a
 * trust line. Replaces the old firstRun behavior of jumping straight to Settings —
 * App now renders this instead and routes each exit (managed / byok / skip)
 * to the same Settings destinations the old jump used, via the existing
 * subscribeNonce / settingsOpenTab mechanisms (see App.tsx).
 *
 * G3 note: this screen's hero VailieMark is the only *other* animated
 * instance besides the top bar while it's showing (idle top-bar + idle
 * hero = 2), so it stays within the ≤2 concurrent-animation budget.
 */
import { useT } from "@/lib/i18n";
import VailieMark from "./VailieMark";

interface OnboardingProps {
  onPickManaged: () => void;
  onPickByok: () => void;
  onSkip: () => void;
}

export default function Onboarding({ onPickManaged, onPickByok, onSkip }: OnboardingProps) {
  const t = useT();
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-8 overflow-y-auto bg-canvas px-6 py-10">
      <button
        type="button"
        onClick={onSkip}
        className="absolute right-4 top-4 rounded-[10px] px-2.5 py-1.5 text-[12px] text-fg-3 transition-colors hover:bg-field hover:text-fg-1"
      >
        {t("onboarding.skip")}
      </button>

      <div className="flex flex-col items-center gap-4 text-center">
        {/* Decorative — the h1 right below already carries this accessibly;
            a label here would just announce the same text twice. */}
        <VailieMark size={132} state="idle" />
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-fg-1">
            {t("onboarding.title")}
          </h1>
          <p className="max-w-[280px] text-[13px] leading-5 text-fg-2">
            {t("onboarding.subtitle")}
          </p>
        </div>
      </div>

      <div className="flex w-full max-w-[360px] flex-col gap-3">
        <button
          type="button"
          onClick={onPickManaged}
          className="flex flex-col gap-1 rounded-card bg-surface p-4 text-left shadow-[0_4px_16px_rgba(21,25,31,0.05)] transition-colors hover:bg-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        >
          <span className="text-[14px] font-semibold text-fg-1">
            {t("onboarding.managedTitle")}
          </span>
          <span className="text-[12px] leading-[18px] text-fg-2">
            {t("onboarding.managedBody")}
          </span>
        </button>

        <button
          type="button"
          onClick={onPickByok}
          className="flex flex-col gap-1 rounded-card bg-surface p-4 text-left shadow-[0_4px_16px_rgba(21,25,31,0.05)] transition-colors hover:bg-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        >
          <span className="text-[14px] font-semibold text-fg-1">
            {t("onboarding.byokTitle")}
          </span>
          <span className="text-[12px] leading-[18px] text-fg-2">
            {t("onboarding.byokBody")}
          </span>
        </button>
      </div>

      <p className="text-[11px] text-fg-3">{t("onboarding.trustLine")}</p>
    </div>
  );
}
