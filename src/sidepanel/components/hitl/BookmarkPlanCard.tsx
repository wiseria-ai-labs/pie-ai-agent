import { useState } from "react";
import { useT } from "@/lib/i18n";
import type { BookmarkPlanRequest } from "@/lib/browser-data/types";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./HitlCardShell";

interface Props {
  payload: BookmarkPlanRequest;
  /** true = user clicked Apply; the SW handler then performs the ops. */
  onDecision: (apply: boolean) => void;
}

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

const MoveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/** F7 — batch bookmark plan. Model proposes, the user clicks Apply. */
export function BookmarkPlanCard({ payload, onDecision }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const PREVIEW = 5;
  const shown = expanded ? payload.lines : payload.lines.slice(0, PREVIEW);

  return (
    <HitlCardShell
      register="browser"
      icon={<FolderIcon />}
      capsLabel={t("hitl.caps.bookmarkPlan")}
      title={t("browserData.plan.title", { count: payload.totalAffected })}
      description={t("browserData.plan.description")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("browserData.plan.cancel")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="browser" onClick={() => onDecision(true)}>
            {t("browserData.plan.apply")}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {payload.counts.folders > 0 && (
          <span className="rounded-chip border border-line bg-field px-2 py-0.5 text-[11px] text-fg-2">
            {t("browserData.plan.chipFolders", { count: payload.counts.folders })}
          </span>
        )}
        {payload.counts.moves > 0 && (
          <span className="rounded-chip border border-line bg-field px-2 py-0.5 text-[11px] text-fg-2">
            {t("browserData.plan.chipMoves", { count: payload.counts.moves })}
          </span>
        )}
        {payload.counts.renames > 0 && (
          <span className="rounded-chip border border-line bg-field px-2 py-0.5 text-[11px] text-fg-2">
            {t("browserData.plan.chipRenames", { count: payload.counts.renames })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-deep px-3 py-2">
        {shown.map((line, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[12px] leading-[18px]">
            <span
              className={`flex shrink-0 ${line.kind === "add" ? "text-accent" : "text-fg-3"}`}
            >
              {line.kind === "add" ? <FolderIcon /> : <MoveIcon />}
            </span>
            <span className="truncate text-fg-1">{line.text}</span>
            {line.note && <span className="truncate text-[11px] text-fg-3">{line.note}</span>}
            {line.count > 0 && (
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-fg-3">
                +{line.count}
              </span>
            )}
          </div>
        ))}
        {payload.lines.length > PREVIEW && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 self-start text-[11px] text-fg-2 hover:text-fg-1"
          >
            {expanded
              ? t("browserData.plan.showLess")
              : t("browserData.plan.showAll", { count: payload.lines.length })}
          </button>
        )}
      </div>
    </HitlCardShell>
  );
}
