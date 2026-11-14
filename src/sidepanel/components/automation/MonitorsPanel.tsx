import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import { listMonitors } from "@/lib/monitors/store";
import {
  checkMonitorNow,
  deleteMonitor,
  pauseMonitor,
  resumeMonitor,
} from "@/lib/monitors/panel-actions";
import { parseNumber } from "@/lib/monitors/condition";
import type { MonitorPausedReason, MonitorRecord } from "@/lib/monitors/types";
import { conditionLabel, intervalLabel } from "../MonitorDraftCard";

type T = ReturnType<typeof useI18n>["t"];

function whenLabel(ms: number | undefined, locale: string, t: T): string {
  if (ms == null) return "—";
  try {
    return t("monitors.nextCheck", {
      time: new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
    });
  } catch {
    return "—";
  }
}

function pausedLabel(t: T, reason: MonitorPausedReason | undefined): string {
  switch (reason) {
    case "login":
      return t("monitors.statusPausedLogin");
    case "not_found":
      return t("monitors.statusPausedNotFound");
    case "blocked":
      return t("monitors.statusPausedBlocked");
    case "network":
      return t("monitors.statusPausedNetwork");
    default:
      return t("monitors.statusPausedUser");
  }
}

function valueLine(rec: MonitorRecord): string {
  const v = rec.lastValue;
  return v == null || v.length === 0 ? "—" : v.replace(/\n/g, " · ");
}

/**
 * F10 / F11 — monitor list and detail. Reads straight from IDB; mutations go
 * through the SW write channel (panel-actions → monitor-action) so alarms and
 * the injected check run with real deps.
 */
export function MonitorsPanel() {
  const { locale, t } = useI18n();
  const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(async () => {
    setMonitors(await listMonitors());
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    return onStoreChange("monitors", () => void reload());
  }, [reload]);

  const open = monitors.find((m) => m.id === openId) ?? null;

  if (open) {
    return (
      <MonitorDetail
        rec={open}
        locale={locale}
        confirmDelete={confirmDelete}
        onAskDelete={() => setConfirmDelete(true)}
        onCancelDelete={() => setConfirmDelete(false)}
        onDelete={async () => {
          await deleteMonitor(open.id);
          setConfirmDelete(false);
          setOpenId(null);
          await reload();
        }}
        onBack={() => {
          setOpenId(null);
          setConfirmDelete(false);
        }}
        onChanged={reload}
      />
    );
  }

  if (!loading && monitors.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface px-3 py-4 text-[12px] leading-[18px] text-fg-2">
        <span>{t("monitors.empty")}</span>
        <span className="text-fg-3">{t("monitors.hint")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="monitors-list">
      {monitors.map((rec) => {
        const paused = rec.status === "paused";
        const met = rec.status === "active" && rec.lastMet;
        return (
          <button
            key={rec.id}
            type="button"
            data-testid={`monitor-row-${rec.id}`}
            onClick={() => setOpenId(rec.id)}
            className="flex items-start gap-2.5 rounded-[14px] border border-line bg-surface px-3 py-2.5 text-left hover:border-fg-3"
          >
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-line bg-surface-deep font-mono text-[11px] text-fg-2">
              {(rec.title[0] ?? "?").toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium text-fg-1" title={rec.title}>
                {rec.title}
              </span>
              <span className="truncate text-[11px] text-fg-3">
                {conditionLabel(t, rec.condition)} · {intervalLabel(t, rec.intervalMinutes)}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span
                className={`max-w-[110px] truncate font-mono text-[12px] ${
                  paused ? "font-sans text-warning" : met ? "text-success" : "text-fg-1"
                }`}
                title={valueLine(rec)}
              >
                {paused ? pausedLabel(t, rec.pausedReason) : valueLine(rec)}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-fg-3">
                {met && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
                {paused && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
                {paused
                  ? t("monitors.paused")
                  : rec.status === "expired"
                    ? t("monitors.expired")
                    : met
                      ? t("monitors.met")
                      : whenLabel(rec.nextCheckAt, locale, t)}
              </span>
            </div>
          </button>
        );
      })}
      <div className="px-1 pt-1 text-[11px] leading-[16px] text-fg-3">{t("monitors.hint")}</div>
    </div>
  );
}

function MonitorDetail({
  rec,
  locale,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onBack,
  onChanged,
}: {
  rec: MonitorRecord;
  locale: string;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => Promise<void>;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();

  const chart = useMemo(() => {
    const points = rec.history
      .map((h) => ({ at: h.at, n: parseNumber(h.value) }))
      .filter((p): p is { at: number; n: number } => p.n != null)
      .slice(-60);
    if (points.length < 2) return null;
    const values = points.map((p) => p.n);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const w = 300;
    const h = 60;
    const step = w / (points.length - 1);
    return {
      points: points.map((p, i) => `${Math.round(i * step)},${Math.round(h - ((p.n - min) / span) * (h - 6) - 3)}`).join(" "),
      threshold: rec.condition.kind === "number" ? rec.condition.value : null,
      min,
      max,
      span,
      w,
      h,
    };
  }, [rec.history, rec.condition]);

  const thresholdY =
    chart && chart.threshold != null
      ? Math.round(chart.h - ((chart.threshold - chart.min) / chart.span) * (chart.h - 6) - 3)
      : null;

  return (
    <div className="flex flex-col gap-3" data-testid="monitor-detail">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start text-[12px] text-fg-2 hover:text-fg-1"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 18-6-6 6-6" />
        </svg>
        {t("monitors.backToList")}
      </button>

      <div className="rounded-[14px] border border-line bg-surface px-3.5 py-3">
        <div className="flex items-baseline gap-2">
          <span className="max-w-full truncate font-mono text-[16px] text-fg-1" title={valueLine(rec)}>
            {valueLine(rec)}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-fg-3">
            {conditionLabel(t, rec.condition)}
          </span>
        </div>
        {chart && (
          <svg viewBox={`0 0 ${chart.w} ${chart.h}`} preserveAspectRatio="none"
            className="mt-2 h-16 w-full" aria-hidden>
            {thresholdY != null && (
              <line x1="0" y1={thresholdY} x2={chart.w} y2={thresholdY}
                stroke="var(--c-success)" strokeWidth="1" strokeDasharray="3 3" opacity=".7" />
            )}
            <polyline fill="none" stroke="var(--c-accent)" strokeWidth="1.5"
              strokeLinejoin="round" points={chart.points} />
          </svg>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="px-1 caps text-fg-3">{t("monitors.history")}</div>
        <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
          {rec.history.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-fg-3">{t("monitors.noHistory")}</div>
          ) : (
            [...rec.history]
              .reverse()
              .slice(0, 20)
              .map((h, i) => (
                <div key={`${h.at}-${i}`} className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-[12px] last:border-b-0">
                  <span className="shrink-0 font-mono text-[11px] text-fg-3">
                    {new Date(h.at).toLocaleString(locale, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${h.met ? "text-success" : "text-fg-2"}`} title={h.value}>
                    {h.value.replace(/\n/g, " · ")}
                  </span>
                </div>
              ))
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="px-1 caps text-fg-3">{t("monitors.settings")}</div>
        <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
          <SettingRow label={t("monitors.labelCondition")} value={conditionLabel(t, rec.condition)} />
          <SettingRow
            label={t("monitors.labelInterval")}
            value={`${intervalLabel(t, rec.intervalMinutes)} · ${whenLabel(rec.nextCheckAt, locale, t)}`}
          />
          <SettingRow
            label={t("monitors.labelCheckMode")}
            value={rec.fetchMode === "direct" ? t("monitors.checkModeDirect") : t("monitors.checkModeTab")}
          />
          <SettingRow
            label={t("monitors.labelAutoStop")}
            value={new Date(rec.expiresAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}
          />
          <SettingRow label={t("monitors.labelUrl")} value={rec.url.replace(/^https?:\/\//, "")} mono />
        </div>
      </div>

      <div className="flex items-center gap-2 pb-2">
        <DetailButton
          disabled={rec.status !== "active"}
          onClick={async () => {
            await checkMonitorNow(rec.id);
          }}
        >
          {t("monitors.checkNow")}
        </DetailButton>
        {rec.status === "paused" ? (
          <DetailButton onClick={async () => { await resumeMonitor(rec.id); await onChanged(); }}>
            {t("monitors.resume")}
          </DetailButton>
        ) : (
          <DetailButton onClick={async () => { await pauseMonitor(rec.id); await onChanged(); }}>
            {t("monitors.pause")}
          </DetailButton>
        )}
        <span className="flex-1" />
        {confirmDelete ? (
          <>
            <DetailButton onClick={() => void onDelete()} tone="warn">
              {t("monitors.confirmDelete")}
            </DetailButton>
            <DetailButton onClick={onCancelDelete}>{t("common.cancel")}</DetailButton>
          </>
        ) : (
          <DetailButton onClick={onAskDelete} tone="warn">
            {t("monitors.delete")}
          </DetailButton>
        )}
      </div>
    </div>
  );
}

function SettingRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 border-b border-line px-3 py-2 text-[12px] last:border-b-0">
      <span className="shrink-0 text-fg-2">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-right text-fg-3 ${mono ? "font-mono text-[11px]" : ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function DetailButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className={`rounded-[10px] border px-2.5 py-1 text-[11px] disabled:opacity-45 ${
        tone === "warn"
          ? "border-warning-line text-warning hover:bg-warning-tint"
          : "border-line text-fg-2 hover:border-fg-3 hover:text-fg-1"
      }`}
    >
      {children}
    </button>
  );
}
