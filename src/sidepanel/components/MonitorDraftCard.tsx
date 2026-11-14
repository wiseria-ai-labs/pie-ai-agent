import { useState } from "react";
import { useT } from "@/lib/i18n";
import type {
  MonitorDraftPayload,
  MonitorDraftResponse,
} from "@/lib/agent/tools/monitor-meta";
import type { MonitorIntervalMinutes } from "@/lib/monitors/types";
import { m, DURATION, EASE_STANDARD } from "./ui/motion";

interface Props {
  payload: MonitorDraftPayload;
  onSubmit: (res: MonitorDraftResponse) => void;
}

const VALID_INTERVALS: MonitorIntervalMinutes[] = [15, 60, 360, 1440];

const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** Localized label for an interval bucket (F9's "每 1 小时"). */
export function intervalLabel(t: ReturnType<typeof useT>, minutes: number): string {
  if (minutes === 1440) return t("monitors.everyDay");
  if (minutes >= 60) return t("monitors.everyHours", { n: minutes / 60 });
  return t("monitors.everyMinutes", { n: minutes });
}

/** Localized condition summary — mirrors monitor-meta.ts summarizeCondition. */
export function conditionLabel(
  t: ReturnType<typeof useT>,
  c: MonitorDraftPayload["condition"],
): string {
  switch (c.kind) {
    case "changed":
      return t("monitors.condChanged");
    case "number":
      return c.op === "lt"
        ? t("monitors.condBelow", { value: c.value })
        : t("monitors.condAbove", { value: c.value });
    case "contains":
      return t("monitors.condContains", { text: c.text });
    case "list_added":
      return t("monitors.condListAdded");
  }
}

/**
 * F9 — page-monitor draft card, rendered inline in the message stream via
 * HitlInlineCards. The trial result decides the shape:
 *   trial.ok     → 盯住 / 条件 / 频率 + [取消] [开始监控]
 *   !trial.ok    → explanation + scheduled-task fallback, cancel only (§4.4)
 */
export function MonitorDraftCard({ payload, onSubmit }: Props) {
  const t = useT();
  const [interval, setInterval] = useState<MonitorIntervalMinutes>(payload.intervalMinutes);
  const trial = payload.trial;

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-3.5"
      data-testid="monitor-draft-card"
    >
      <div className="flex items-center gap-2">
        <span className="text-accent"><EyeIcon /></span>
        <span className="caps text-accent">{t("monitors.draftLabel")}</span>
        <span className="ml-auto font-mono text-[12px] text-fg-2">propose_monitor</span>
      </div>

      <div className="text-[15px] font-semibold leading-[22px] tracking-[-0.005em] text-fg-1">
        {payload.title}
      </div>

      <div className="flex flex-col gap-2 text-[12px] leading-[18px]">
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-fg-3">{t("monitors.draftWatching")}</span>
          <span className="rounded-full border border-line bg-surface-deep px-2 py-0.5 font-mono text-[11px] text-fg-1">
            {payload.url.replace(/^https?:\/\//, "").slice(0, 48)}
          </span>
        </div>
        {trial.ok ? (
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-fg-3">{t("monitors.trialValue")}</span>
            <span className="rounded-full border border-line bg-surface-deep px-2 py-0.5 font-mono text-[11px] text-fg-1">
              {trial.value.replace(/\n/g, " · ").slice(0, 60)}
            </span>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-fg-3">{t("monitors.draftCondition")}</span>
          <span className="rounded-full border border-line bg-surface-deep px-2 py-0.5 text-[11px] text-fg-1">
            {conditionLabel(t, payload.condition)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-fg-3">{t("monitors.draftFrequency")}</span>
          <select
            data-testid="monitor-draft-interval"
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value) as MonitorIntervalMinutes)}
            className="rounded-[8px] border border-line bg-surface-deep px-2 py-1 text-[11px] text-fg-1"
          >
            {VALID_INTERVALS.map((v) => (
              <option key={v} value={v}>{intervalLabel(t, v)}</option>
            ))}
          </select>
          <span className="text-[11px] text-fg-3">· {t("monitors.draftAutoStop")}</span>
        </div>
      </div>

      {!trial.ok ? (
        <div
          data-testid="monitor-draft-trial-failed"
          className="flex flex-col gap-1.5 rounded-[8px] border border-warning-line bg-warning-tint px-3 py-2 text-[12px] leading-[18px] text-fg-2"
        >
          <span className="font-medium text-warning">
            {trial.reason === "login"
              ? t("monitors.trialFailedLogin")
              : trial.reason === "blocked"
                ? t("monitors.trialFailedBlocked")
                : t("monitors.trialFailed")}
          </span>
          <span className="text-fg-3">{t("monitors.trialFailedFallback")}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => onSubmit({ action: "cancel" })}
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-medium text-fg-2"
        >
          {t("common.cancel")}
        </button>
        {trial.ok && (
          <button
            type="button"
            data-testid="monitor-draft-start"
            onClick={() => onSubmit({ action: "start", intervalMinutes: interval })}
            className="rounded-lg border border-accent-line bg-accent-strong px-4 py-2 text-[13px] font-semibold text-surface"
          >
            {t("monitors.draftStart")}
          </button>
        )}
      </div>
    </m.div>
  );
}
