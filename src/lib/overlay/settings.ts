// Overlay settings — one config record, read by both the side panel (F16
// settings page) and the SW (which ships the relevant subset to the content
// script). Content scripts cannot read the extension's IDB, so the SW is the
// only consumer of this module inside the content-script path.

import { getConfig, setConfig } from "@/lib/idb/config-store";

export const OVERLAY_SETTINGS_KEY = "overlay_settings";

export type OverlayPosition = "anchor" | "top";
export type OverlayRetentionMinutes = 10 | 30 | 60;

export interface OverlaySettings {
  /** Master switch for the selection bar. */
  barEnabled: boolean;
  /** Hosts where the bar never appears ("在此网站不显示"). */
  excludedHosts: string[];
  /** anchor = under the selection, top = top-center of the viewport. */
  position: OverlayPosition;
  /** How long a closed overlay remembers its conversation on the same tab. */
  retentionMinutes: OverlayRetentionMinutes;
}

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  barEnabled: true,
  excludedHosts: [],
  position: "anchor",
  retentionMinutes: 30,
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
    position: r.position === "top" ? "top" : "anchor",
    retentionMinutes: retention === 10 || retention === 60 ? retention : 30,
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
