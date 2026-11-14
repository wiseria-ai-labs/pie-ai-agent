// Overlay settings — one config record, read by both the side panel (F16
// settings page) and the SW (which ships the relevant subset to the content
// script). Content scripts cannot read the extension's IDB, so the SW is the
// only consumer of this module inside the content-script path.

import { getConfig, setConfig } from "@/lib/idb/config-store";

export const OVERLAY_SETTINGS_KEY = "overlay_settings";

export type OverlayPosition = "anchor" | "bottom";
export type OverlayRetentionMinutes = 10 | 30 | 60;

export interface OverlaySettings {
  /** Master switch for the selection bar. */
  barEnabled: boolean;
  /** Hosts where the bar never appears ("在此网站不显示"). */
  excludedHosts: string[];
  /** anchor = under the selection (bottom-center without one), bottom = always bottom-center. */
  position: OverlayPosition;
  /** How long a closed overlay remembers its conversation on the same tab. */
  retentionMinutes: OverlayRetentionMinutes;
  /** Last target language the user picked in the translate chip (global). */
  lastTranslateLang?: string;
  /** Most recent custom rewrite instructions, newest first (max 3, global). */
  recentRewriteStyles: string[];
}

export const MAX_RECENT_REWRITE_STYLES = 3;

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  barEnabled: true,
  excludedHosts: [],
  position: "anchor",
  retentionMinutes: 30,
  recentRewriteStyles: [],
};

/** Coerce a stored (possibly partial / legacy / hand-edited) record. */
export function normalizeOverlaySettings(raw: unknown): OverlaySettings {
  const r = (raw ?? {}) as Partial<OverlaySettings>;
  const retention = r.retentionMinutes;
  return {
    barEnabled: typeof r.barEnabled === "boolean" ? r.barEnabled : DEFAULT_OVERLAY_SETTINGS.barEnabled,
    excludedHosts: Array.isArray(r.excludedHosts)
      ? r.excludedHosts.filter((h): h is string => typeof h === "string" && h.length > 0)
      : [],
    // "top" is the pre-2.0 name of the fixed position, now bottom-center.
    position: r.position === "bottom" || (r.position as string) === "top" ? "bottom" : "anchor",
    retentionMinutes: retention === 10 || retention === 60 ? retention : 30,
    ...(typeof r.lastTranslateLang === "string" && r.lastTranslateLang.length > 0
      ? { lastTranslateLang: r.lastTranslateLang }
      : {}),
    recentRewriteStyles: Array.isArray(r.recentRewriteStyles)
      ? r.recentRewriteStyles
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .slice(0, MAX_RECENT_REWRITE_STYLES)
      : [],
  };
}

export async function getOverlaySettings(): Promise<OverlaySettings> {
  return normalizeOverlaySettings(await getConfig<unknown>(OVERLAY_SETTINGS_KEY));
}

export async function setOverlaySettings(patch: Partial<OverlaySettings>): Promise<OverlaySettings> {
  const next = normalizeOverlaySettings({ ...(await getOverlaySettings()), ...patch });
  await setConfig(OVERLAY_SETTINGS_KEY, next);
  return next;
}

/** Remember a custom rewrite instruction for the style chips (newest first). */
export async function rememberRewriteStyle(text: string): Promise<OverlaySettings> {
  const clean = text.trim().slice(0, 200);
  if (!clean) return getOverlaySettings();
  const current = await getOverlaySettings();
  const next = [clean, ...current.recentRewriteStyles.filter((s) => s !== clean)].slice(
    0,
    MAX_RECENT_REWRITE_STYLES,
  );
  return setOverlaySettings({ recentRewriteStyles: next });
}

/** Remember the translate chip's language for the next overlay. */
export async function rememberTranslateLang(lang: string): Promise<OverlaySettings> {
  if (!lang) return getOverlaySettings();
  return setOverlaySettings({ lastTranslateLang: lang });
}

/** Settings page "clear": drop the remembered translate language + styles. */
export async function clearOverlayPreferences(): Promise<OverlaySettings> {
  const next = normalizeOverlaySettings({
    ...(await getOverlaySettings()),
    lastTranslateLang: undefined,
    recentRewriteStyles: [],
  });
  await setConfig(OVERLAY_SETTINGS_KEY, next);
  return next;
}

/** Hosts list update helper for the "don't show on this site" menu item. */
export async function excludeHostForSelectionBar(host: string): Promise<OverlaySettings> {
  const current = await getOverlaySettings();
  if (!host || current.excludedHosts.includes(host)) return current;
  return setOverlaySettings({ excludedHosts: [...current.excludedHosts, host] });
}

/**
 * Whether the selection bar may appear on `host`. Pure so the content-script
 * side can be exercised in tests without IDB.
 */
export function shouldShowSelectionBar(
  settings: Pick<OverlaySettings, "barEnabled" | "excludedHosts">,
  host: string,
): boolean {
  if (!settings.barEnabled) return false;
  return !settings.excludedHosts.includes(host);
}
