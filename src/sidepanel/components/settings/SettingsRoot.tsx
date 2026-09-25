import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Box,
  Plug,
  Search,
  Contrast,
  Globe,
  MessageSquare,
  ScrollText,
  MousePointerClick,
  AppWindow,
  MessageCircle,
  Info,
  HelpCircle,
  ChevronRight,
  ZoomIn,
  RotateCcw,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { listInstances } from "@/lib/instances";
import { getSearchProviderStatus, ACTIVE_SEARCH_PROVIDER } from "@/lib/search-provider";
import { isCdpInputEnabled, setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import { getPanelMode, setPanelMode, PANEL_MODE_KEY } from "@/lib/panel-host/panel-mode";
import { onStoreChange } from "@/lib/store-bus";
import { setConfig } from "@/lib/idb/config-store";
import { Switch } from "@/sidepanel/components/ui/Switch";
import { IconButton } from "@/sidepanel/components/ui/IconButton";
import { Popover } from "@/sidepanel/components/ui/Popover";
import { useAnchorRect, viewportSize, rootZoom } from "@/sidepanel/components/ui/useAnchorRect";
import { type ThemeMode, UI_SCALE_KEY, applyUiScale } from "@/sidepanel/theme";
import type { SettingsPage } from "@/sidepanel/components/TopBar";
import { useBridgeStatus } from "./bridge-status";

const ROW_ICON = { size: 16, strokeWidth: 1.75 } as const;

export interface SettingsRootProps {
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
  onOpenPage: (p: Exclude<SettingsPage, "root">) => void;
}

// ── A single drill-down / control row ─────────────────────────────────────────
function NavRow({
  id,
  icon,
  label,
  badge,
  onClick,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`settings-row-${id}`}
      onClick={onClick}
      className="flex h-[46px] w-full items-center gap-3 border-t border-line px-3.5 text-left first:border-t-0 hover:bg-field"
    >
      <span className="shrink-0 text-fg-2">{icon}</span>
      <span className="flex-1 text-[13px] font-medium text-fg-1">{label}</span>
      {badge != null && (
        <span data-testid={`settings-badge-${id}`} className="text-[12px] text-fg-3">
          {badge}
        </span>
      )}
      <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-fg-3" />
    </button>
  );
}

// A non-button row (for inline controls like the theme segmented / CDP switch).
// `help` renders right after the label (the "?" explainer button).
function ControlRow({
  icon,
  label,
  help,
  control,
}: {
  icon: ReactNode;
  label: string;
  help?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex min-h-[46px] w-full flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3.5 py-2 first:border-t-0">
      <span className="shrink-0 text-fg-2">{icon}</span>
      {/* flex-1 label + ml-auto control (no spacer): when the row runs out of
          room (narrow panel × large interface scale) the label wraps its text
          first, and a control that still doesn't fit drops to its own line
          flush right — instead of overflowing. */}
      <span className="flex flex-1 items-center gap-1 text-[13px] font-medium text-fg-1">
        {label}
        {help}
      </span>
      <div className="ml-auto shrink-0">{control}</div>
    </div>
  );
}

const HELP_W = 280; // "?" popover width — kept in sync with the clamp below

/** Left-align the "?" popover to its trigger, then clamp inside the panel — the
 *  trigger sits far right in a ~420px side panel, so an unclamped popover runs
 *  off the edge. Pure (viewport width passed in) so it stays unit-testable. */
export function helpCoords(rect: DOMRect, viewportW = viewportSize().w): { left: number; width: number } {
  const MARGIN = 8;
  const width = Math.min(HELP_W, viewportW - 2 * MARGIN);
  const left = Math.max(MARGIN, Math.min(rect.left - 12, viewportW - width - MARGIN));
  return { left, width };
}

// CDP input simulation — an inline switch (no sub-page). The "?" reveals the
// explainer on hover (focus too, for keyboard users): what enabling it means —
// the yellow debugger bar + DevTools conflict. Hover-only, so the explainer
// costs no room and no click.
function CdpRow() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLSpanElement>(null);
  const rect = useAnchorRect(helpRef, helpOpen);

  useEffect(() => {
    void isCdpInputEnabled().then((v) => setEnabled(v === true));
  }, []);

  return (
    <ControlRow
      icon={<MousePointerClick {...ROW_ICON} />}
      label={t("settings.cdpInput.title")}
      help={
        <>
          <span
            ref={helpRef}
            data-testid="cdp-help"
            tabIndex={0}
            role="button"
            aria-label={t("settings.cdpInput.title")}
            aria-expanded={helpOpen}
            onMouseEnter={() => setHelpOpen(true)}
            onMouseLeave={() => setHelpOpen(false)}
            onFocus={() => setHelpOpen(true)}
            onBlur={() => setHelpOpen(false)}
            className="flex h-4 w-4 items-center justify-center text-fg-3 hover:text-fg-1"
          >
            <HelpCircle size={14} strokeWidth={1.75} />
          </span>
          <Popover
            open={helpOpen && !!rect}
            role="tooltip"
            style={rect ? { ...helpCoords(rect), top: rect.bottom + 6 } : undefined}
            // pointer-events-none: the popover sits under the cursor's path out
            // of the trigger — letting it swallow hover would flicker it.
            className="pointer-events-none fixed z-[100] flex flex-col gap-2 rounded-card border border-line bg-surface p-3 shadow-pop"
          >
            <p className="text-[12px] leading-[18px] font-normal text-fg-2">
              {t("settings.cdpInput.description")}
            </p>
            <div className="flex flex-col gap-1.5 rounded-chip border border-warning-line bg-warning-tint px-2.5 py-2 text-[11px] leading-[16px] text-warning">
              <span className="font-medium">{t("settings.cdpInput.warningTitle")}</span>
              <ul className="flex flex-col gap-1 pl-3 font-normal text-warning/90">
                <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning1")}</li>
                <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning2")}</li>
                <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning3")}</li>
              </ul>
            </div>
          </Popover>
        </>
      }
      control={
        <Switch
          testId="cdp-switch"
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            void setCdpInputEnabled(next);
          }}
        />
      }
    />
  );
}

/**
 * Panel display mode.
 *
 * Exists because auto-detection cannot be trusted on every Chromium fork: some
 * accept the side-panel API, report success through every observable signal,
 * and still show nothing. The user can see what the probes cannot, so they get
 * the final say. Pie flips this on by itself when detection does catch the
 * problem — leaving this row as the way to review or undo that.
 */
function PanelWindowRow() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void getPanelMode().then((m) => setEnabled(m === "window"));
    // Reflect the automatic switch-over (or a change made from another panel)
    // without needing a reopen.
    return onStoreChange("config", (c) => {
      if (c.id === PANEL_MODE_KEY) void getPanelMode().then((m) => setEnabled(m === "window"));
    });
  }, []);

  return (
    <ControlRow
      icon={<AppWindow {...ROW_ICON} />}
      label={t("settings.panelWindow.title")}
      control={
        <Switch
          testId="panel-window-switch"
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            void setPanelMode(next ? "window" : "auto");
          }}
        />
      }
    />
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">{children}</div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 pb-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-fg-3">
      {children}
    </div>
  );
}

function ThemeSegmented({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
}) {
  const t = useT();
  return (
    <div className="flex gap-0.5 rounded-lg border border-line bg-field p-0.5">
      {(["light", "dark", "system"] as const).map((m) => (
        <button
          key={m}
          type="button"
          data-testid={`theme-${m}`}
          aria-pressed={themeMode === m}
          onClick={() => onThemeModeChange(m)}
          className={`rounded-md px-2.5 py-0.5 text-[11px] ${
            themeMode === m ? "bg-canvas font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"
          }`}
        >
          {t(`settings.theme.${m}`)}
        </button>
      ))}
    </div>
  );
}

function persistUiScale(pct: number) {
  localStorage.setItem(UI_SCALE_KEY, String(pct / 100));
  void setConfig(UI_SCALE_KEY, pct / 100);
}

// Interface scale — CSS zoom on the whole panel (theme.ts). Dragging previews
// live; the native `change` event (fires on release / per keyboard step)
// persists. The track gets its own full-width line on purpose: zooming resizes
// the slider under the pointer, and a full-width track scales about its middle
// so the value under the cursor barely moves — a short track at the row's end
// drifts enough to feed back into its own value and run away mid-drag.
function UiScaleRow() {
  const t = useT();
  const [pct, setPct] = useState(() => Math.round(rootZoom() * 100));
  const sliderRef = useRef<HTMLInputElement>(null);

  const preview = (p: number) => {
    setPct(p);
    applyUiScale(p / 100);
  };

  useEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    const onCommit = () => persistUiScale(Number(el.value));
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, []);

  return (
    <div className="flex w-full flex-col gap-1.5 border-t border-line px-3.5 py-2.5 first:border-t-0">
      <div className="flex min-h-[26px] items-center gap-3">
        <span className="shrink-0 text-fg-2">
          <ZoomIn {...ROW_ICON} />
        </span>
        <span className="flex-1 text-[13px] font-medium text-fg-1">{t("settings.uiScale.label")}</span>
        <span data-testid="ui-scale-value" className="font-mono text-[11px] tabular-nums text-fg-2">
          {pct}%
        </span>
        <IconButton
          size="sm"
          data-testid="ui-scale-reset"
          aria-label={t("settings.uiScale.reset")}
          title={t("settings.uiScale.reset")}
          icon={<RotateCcw size={13} strokeWidth={1.75} />}
          disabled={pct === 100}
          onClick={() => {
            preview(100);
            persistUiScale(100);
          }}
        />
      </div>
      <input
        ref={sliderRef}
        type="range"
        data-testid="ui-scale-slider"
        min={70}
        max={150}
        step={5}
        value={pct}
        aria-label={t("settings.uiScale.label")}
        aria-valuetext={`${pct}%`}
        onChange={(e) => preview(Number(e.target.value))}
        className="ml-7 cursor-pointer accent-accent"
      />
    </div>
  );
}

export default function SettingsRoot({
  themeMode,
  onThemeModeChange,
  onOpenPage,
}: SettingsRootProps) {
  const t = useT();
  const [configCount, setConfigCount] = useState<number | null>(null);
  // Poll the bridge so the badge tracks connect/disconnect while the settings
  // page stays open — a one-shot query at mount misses the handshake that
  // completes moments later (issue #298).
  const bridge = useBridgeStatus();
  const [searchConfigured, setSearchConfigured] = useState(false);

  useEffect(() => {
    let alive = true;
    void listInstances().then((l) => {
      if (alive) setConfigCount(l.length);
    });
    void getSearchProviderStatus(ACTIVE_SEARCH_PROVIDER).then((s) => {
      if (alive) setSearchConfigured(s.configured);
    });
    return () => {
      alive = false;
    };
  }, []);

  const bridgeBadge =
    bridge && bridge.hasPermission ? (
      <span className="flex items-center gap-1.5">
        {bridge.ready && (
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        )}
        {bridge.ready ? t("settings.nav.bridgeConnected") : t("settings.nav.bridgeOff")}
      </span>
    ) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {/* Group 1 — basics (core subsystems + CDP) */}
      <div>
        <GroupLabel>{t("settings.nav.basics")}</GroupLabel>
        <Group>
          <NavRow
            id="models"
            icon={<Box {...ROW_ICON} />}
            label={t("settings.nav.models")}
            badge={
              configCount != null
                ? t("settings.nav.configCount", { count: String(configCount) })
                : undefined
            }
            onClick={() => onOpenPage("models")}
          />
          <NavRow
            id="bridge"
            icon={<Plug {...ROW_ICON} />}
            label={t("settings.nav.bridge")}
            badge={bridgeBadge}
            onClick={() => onOpenPage("bridge")}
          />
          <NavRow
            id="search"
            icon={<Search {...ROW_ICON} />}
            label={t("settings.nav.search")}
            badge={searchConfigured ? t("settings.nav.configured") : undefined}
            onClick={() => onOpenPage("search")}
          />
          <CdpRow />
        </Group>
      </div>

      {/* Group 2 — preferences */}
      <div>
        <GroupLabel>{t("settings.nav.preferences")}</GroupLabel>
        <Group>
          <ControlRow
            icon={<Contrast {...ROW_ICON} />}
            label={t("settings.theme.label")}
            control={<ThemeSegmented themeMode={themeMode} onThemeModeChange={onThemeModeChange} />}
          />
          <UiScaleRow />
          <PanelWindowRow />
          <NavRow
            id="uiLanguage"
            icon={<Globe {...ROW_ICON} />}
            label={t("settings.language.uiLabel")}
            onClick={() => onOpenPage("uiLanguage")}
          />
          <NavRow
            id="assistantLanguage"
            icon={<MessageSquare {...ROW_ICON} />}
            label={t("settings.language.assistantLabel")}
            onClick={() => onOpenPage("assistantLanguage")}
          />
          <NavRow
            id="customRules"
            icon={<ScrollText {...ROW_ICON} />}
            label={t("settings.nav.customRules")}
            onClick={() => onOpenPage("customRules")}
          />
        </Group>
      </div>

      {/* Group 3 — about & support */}
      <div>
        <GroupLabel>{t("settings.nav.support")}</GroupLabel>
        <Group>
          <NavRow
            id="feedback"
            icon={<MessageCircle {...ROW_ICON} />}
            label={t("settings.nav.feedback")}
            onClick={() => onOpenPage("feedback")}
          />
          <NavRow
            id="about"
            icon={<Info {...ROW_ICON} />}
            label={t("settings.nav.about")}
            badge={`v${chrome.runtime.getManifest().version}`}
            onClick={() => onOpenPage("about")}
          />
        </Group>
      </div>
    </div>
  );
}
