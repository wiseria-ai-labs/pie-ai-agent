import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { LOCALE_REGISTRY } from "@/lib/i18n/locales";
import { Switch } from "@/sidepanel/components/ui/Switch";
import {
  clearOverlayPreferences,
  getOverlaySettings,
  setOverlaySettings,
  type OverlayRetentionMinutes,
  type OverlaySettings,
} from "@/lib/overlay/settings";

// F16 — 设置 · 浮层与快捷键。
//
// Shortcut display only: Chrome owns the binding (chrome://extensions/shortcuts
// is the only place a web page cannot fake or override), so this page shows the
// current default and links out. The other rows are real settings the overlay
// reads on every open (settings come from the SW, which reads this record).

const SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "⌘⇧K"
    : "Ctrl+Shift+K";

function GroupLabel({ children }: { children: string }) {
  return (
    <div className="px-1 pb-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-fg-3">
      {children}
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">{children}</div>
  );
}

function Row({
  label,
  hint,
  control,
  onClick,
}: {
  label: string;
  hint?: string;
  control?: React.ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-[13px] font-medium text-fg-1">{label}</span>
        {hint && <span className="text-[11.5px] leading-[16px] text-fg-3">{hint}</span>}
      </span>
      {control}
    </>
  );
  if (!onClick) {
    return (
      <div className="flex min-h-[46px] items-center gap-3 border-t border-line px-3.5 py-2 first:border-t-0">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[46px] w-full items-center gap-3 border-t border-line px-3.5 py-2 text-left first:border-t-0 hover:bg-field"
    >
      {body}
    </button>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-line bg-field p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-0.5 text-[11px] ${
            value === o.value ? "bg-canvas font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function OverlayPage() {
  const t = useT();
  const [settings, setSettings] = useState<OverlaySettings | null>(null);

  useEffect(() => {
    let alive = true;
    void getOverlaySettings().then((s) => {
      if (alive) setSettings(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const update = (patch: Partial<OverlaySettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    void setOverlaySettings(patch).then(setSettings);
  };

  const openShortcutSettings = () => {
    // Chrome blocks navigation to most chrome:// pages from an extension, but
    // extensions/shortcuts is allowed from a user gesture in practice; a
    // failure is silent (the hint text already tells the user where to go).
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {});
  };

  const excluded = settings?.excludedHosts ?? [];

  return (
    <section className="flex flex-col gap-5" data-testid="settings-overlay-page">
      <div>
        <GroupLabel>{t("settings.overlay.groupInvoke")}</GroupLabel>
        <Group>
          <Row
            label={t("settings.overlay.shortcutLabel")}
            hint={t("settings.overlay.shortcutHint")}
            control={<kbd className="rounded-chip border border-line bg-field px-2 py-0.5 font-mono text-[11px] text-fg-1">{SHORTCUT_LABEL}</kbd>}
          />
          <Row label={t("settings.overlay.changeShortcut")} onClick={openShortcutSettings} />
          <Row
            label={t("settings.overlay.omniboxLabel")}
            hint={t("settings.overlay.omniboxHint")}
            control={<span className="rounded-chip border border-line bg-field px-2 py-0.5 font-mono text-[11px] text-fg-1">pie</span>}
          />
        </Group>
      </div>

      <div>
        <GroupLabel>{t("settings.overlay.groupBar")}</GroupLabel>
        <Group>
          <Row
            label={t("settings.overlay.barLabel")}
            control={
              <Switch
                testId="overlay-bar-switch"
                checked={settings?.barEnabled ?? true}
                onChange={(next) => update({ barEnabled: next })}
              />
            }
          />
          <Row
            label={t("settings.overlay.excludedLabel")}
            hint={
              excluded.length > 0
                ? excluded.slice(0, 3).join(", ") + (excluded.length > 3 ? " …" : "")
                : t("settings.overlay.excludedEmpty")
            }
            control={
              excluded.length > 0 ? (
                <button
                  type="button"
                  data-testid="overlay-excluded-clear"
                  onClick={() => update({ excludedHosts: [] })}
                  className="text-[11.5px] text-accent hover:underline"
                >
                  {t("settings.overlay.clearExcluded")}
                </button>
              ) : undefined
            }
          />
        </Group>
      </div>

      <div>
        <GroupLabel>{t("settings.overlay.groupOverlay")}</GroupLabel>
        <Group>
          <Row
            label={t("settings.overlay.positionLabel")}
            control={
              <Segmented
                value={settings?.position ?? "anchor"}
                options={[
                  { value: "anchor", label: t("settings.overlay.positionAnchor") },
                  { value: "bottom", label: t("settings.overlay.positionBottom") },
                ]}
                onChange={(v) => update({ position: v })}
              />
            }
          />
          <Row
            label={t("settings.overlay.retentionLabel")}
            hint={t("settings.overlay.retentionHint")}
            control={
              <Segmented<OverlayRetentionMinutes>
                value={settings?.retentionMinutes ?? 30}
                options={[
                  { value: 10, label: t("settings.overlay.retention10") },
                  { value: 30, label: t("settings.overlay.retention30") },
                  { value: 60, label: t("settings.overlay.retention60") },
                ]}
                onChange={(v) => update({ retentionMinutes: v })}
              />
            }
          />
        </Group>
      </div>

      <div>
        <GroupLabel>{t("settings.overlay.groupRemembered")}</GroupLabel>
        <Group>
          <Row
            label={t("settings.overlay.translateLangLabel")}
            control={
              <span className="text-[12px] text-fg-2" data-testid="overlay-remembered-lang">
                {settings?.lastTranslateLang
                  ? (LOCALE_REGISTRY[settings.lastTranslateLang as keyof typeof LOCALE_REGISTRY]
                      ?.nativeLabel ?? settings.lastTranslateLang)
                  : t("settings.overlay.rememberedEmpty")}
              </span>
            }
          />
          <Row
            label={t("settings.overlay.rewriteStylesLabel")}
            hint={
              (settings?.recentRewriteStyles.length ?? 0) > 0
                ? settings!.recentRewriteStyles.join(" · ")
                : t("settings.overlay.rememberedEmpty")
            }
            control={
              settings?.lastTranslateLang || (settings?.recentRewriteStyles.length ?? 0) > 0 ? (
                <button
                  type="button"
                  data-testid="overlay-remembered-clear"
                  onClick={() => void clearOverlayPreferences().then(setSettings)}
                  className="text-[11.5px] text-accent hover:underline"
                >
                  {t("settings.overlay.clearRemembered")}
                </button>
              ) : undefined
            }
          />
        </Group>
      </div>

      <p className="px-1 text-[11.5px] leading-[17px] text-fg-3">
        {t("settings.overlay.restrictedHint")}
      </p>
    </section>
  );
}
