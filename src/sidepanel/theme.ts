/** Theme mode — light / dark / system(auto). Owned by App.tsx state; the
 *  segmented control in the Settings root page reads and writes it. Migrated
 *  out of the removed TopBarThemeButton so the type outlives that component. */
export type ThemeMode = "light" | "dark" | "system";

/** Interface scale — CSS `zoom` on <html>, 1 = 100%. Persisted like theme-mode:
 *  localStorage (read by main.tsx's pre-paint bootstrap) + IDB `config` (the
 *  store-bus event syncs other open panels). Same key in both. */
export const UI_SCALE_KEY = "ui-scale";
export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;

/** Stored value → scale. Anything non-numeric or outside [0.7, 1.5] → 1. */
export function parseUiScale(raw: unknown): number {
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  return n >= UI_SCALE_MIN && n <= UI_SCALE_MAX ? n : 1;
}

/** Zoom the whole panel. `--ui-zoom` mirrors it for CSS: viewport units are
 *  zoomed too, so `60vh` must be written `calc(60vh/var(--ui-zoom,1))` to stay
 *  60% of the real viewport. 1 clears both (老用户零变化). */
export function applyUiScale(scale: number): void {
  const s = document.documentElement.style;
  const v = scale === 1 ? "" : String(scale);
  s.zoom = v;
  s.setProperty("--ui-zoom", v);
}
