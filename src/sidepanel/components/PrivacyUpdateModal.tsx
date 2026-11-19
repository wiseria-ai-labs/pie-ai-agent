import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getPrivacyPolicyUrl } from "@/lib/privacy-consent";
import { MeshSparkle } from "./MeshSparkle";
import { Button } from "./ui/Button";

export interface PrivacyUpdateModalProps {
  onAgree: () => Promise<void> | void;
  onDecline: () => Promise<void> | void;
}

export default function PrivacyUpdateModal({ onAgree, onDecline }: PrivacyUpdateModalProps) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState<"agree" | "decline" | null>(null);

  async function handleAgree() {
    if (busy) return;
    setBusy("agree");
    try {
      await onAgree();
    } finally {
      setBusy(null);
    }
  }

  async function handleDecline() {
    if (busy) return;
    setBusy("decline");
    try {
      await onDecline();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-update-title"
      data-testid="privacy-update-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="flex w-full max-w-sm flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-5 shadow-lg">
        <div className="flex items-center gap-1.5 text-accent">
          <MeshSparkle size={13} />
          <span className="font-mono text-[10px] font-semibold tracking-[0.14em]">
            {t("settings.memory.privacyConsent.badge")}
          </span>
        </div>

        <h2
          id="privacy-update-title"
          className="text-[16px] font-semibold leading-[22px] text-fg-1"
        >
          {t("settings.memory.privacyConsent.title")}
        </h2>

        <p className="text-[12.5px] leading-[19px] text-fg-2">
          {t("settings.memory.privacyConsent.body")}
        </p>

        <div className="rounded-control border border-line bg-field px-3 py-2.5 text-[11.5px] leading-[17px] text-fg-2">
          {t("settings.memory.privacyConsent.controlNote")}
        </div>

        <a
          href={getPrivacyPolicyUrl(locale)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="privacy-update-policy-link"
          className="inline-flex w-fit items-center gap-1 text-[12px] font-medium text-accent hover:underline"
        >
          {t("settings.memory.privacyConsent.readPolicy")}
          <ArrowUpRight size={13} strokeWidth={1.75} />
        </a>

        <div className="flex flex-col gap-2 pt-1">
          <Button
            variant="primary"
            size="md"
            fullWidth
            loading={busy === "agree"}
            disabled={busy !== null}
            data-testid="privacy-update-agree"
            onClick={() => void handleAgree()}
          >
            {t("settings.memory.privacyConsent.agree")}
          </Button>
          <Button
            variant="secondary"
            size="md"
            fullWidth
            loading={busy === "decline"}
            disabled={busy !== null}
            data-testid="privacy-update-decline"
            onClick={() => void handleDecline()}
          >
            {t("settings.memory.privacyConsent.declineMemory")}
          </Button>
        </div>
      </div>
    </div>
  );
}
