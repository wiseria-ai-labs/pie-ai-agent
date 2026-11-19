import { useT } from "@/lib/i18n";
import type { HistoryDeletionRequest } from "@/lib/browser-data/types";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./HitlCardShell";

interface Props {
  payload: HistoryDeletionRequest;
  /** true = user clicked "删除 N 条"; the SW handler then deletes. */
  onDecision: (confirmed: boolean) => void;
}

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);

/** Localized `MM-DD` for the matched range (device locale). */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

/**
 * F8 — history deletion card. Irreversible, so the primary button names the
 * exact count and the warning is coral. History is never snapshotted: Chrome
 * can re-add a URL but not its original visit times (spec §3.2).
 */

export function HistoryDeletionCard({ payload, onDecision }: Props) {
  const t = useT();
  const range = t("browserData.deletion.rangeSites", {
    sites: payload.sites.length,
    from: shortDate(payload.from),
    to: shortDate(payload.to),
  });
  return (
    <HitlCardShell
      register="danger"
      icon={<TrashIcon />}
      capsLabel={t("hitl.caps.historyDeletion")}
      title={t("browserData.deletion.title", { count: payload.count })}
      description={range}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("common.cancel")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="danger" onClick={() => onDecision(true)}>
            {t("browserData.deletion.deleteCount", { count: payload.count })}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-deep px-3 py-2">
        <span className="caps text-fg-3">{t("browserData.deletion.sitesLabel")}</span>
        {payload.sites.map((s) => (
          <div key={s.domain} className="flex items-center gap-2 text-[12px] leading-[18px]">
            <span className="truncate text-fg-1">{s.domain}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-fg-3">
              {s.count}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-1.5 rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[11px] leading-[17px] text-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
        <span>{t("browserData.deletion.warning")}</span>
      </div>
    </HitlCardShell>
  );
}
