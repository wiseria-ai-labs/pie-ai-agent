import type { Locale } from "@/lib/i18n/types";
import { websiteLocalePath } from "./website-locale";
import { buildHolidaySaleUrl, isHolidaySaleActive } from "./holiday-sale";

export { websiteLocalePath };

// Post-update changelog notification (issue #351).
//
// After an extension auto-update, Pie opens a tab pointing at the website
// changelog page — but ONLY for a minor or major version bump. Patch bumps stay
// completely silent (Chrome updates silently in the background; a tab on every
// patch would nag the user). Downgrades, no-op reinstalls, and missing/garbage
// previousVersion values are all silent too.
//
// During the Black Friday & Christmas 2026 Holiday Sale UTC window, ANY strictly
// increasing version update (including patch bumps) opens the localized `/holiday`
// campaign page instead. Outside the window, behavior reverts strictly to
// minor/major changelog rules.
//
// The logic is a pure function with a single-purpose test matrix so the
// pop/no-pop decision never regresses.

/**
 * Parse an `x.y[.z...]` version string into numeric components.
 * Returns null when the string is missing or not a dot-joined run of
 * non-negative integers (at least `major.minor`).
 */
function parseVersionParts(v: string | undefined): number[] | null {
  if (typeof v !== "string") return null;
  const parts = v.trim().split(".");
  if (parts.length < 2) return null;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
  }
  return parts.map(Number);
}

/**
 * True when `currentVersion` is strictly greater than `previousVersion`
 * across all numeric segments (major, minor, patch, ...).
 */
function isStrictlyNewerVersion(
  previousVersion: string | undefined,
  currentVersion: string,
): boolean {
  const prev = parseVersionParts(previousVersion);
  const cur = parseVersionParts(currentVersion);
  if (!prev || !cur) return false;
  const len = Math.max(prev.length, cur.length);
  for (let i = 0; i < len; i++) {
    const a = prev[i] ?? 0;
    const b = cur[i] ?? 0;
    if (b !== a) return b > a;
  }
  return false;
}

/**
 * Decide whether an extension update from `previousVersion` to `currentVersion`
 * should open the changelog tab. True only when the (major, minor) tuple
 * strictly increased — i.e. a minor or major bump. Everything else (patch-only,
 * identical, downgrade, or an unparseable/absent previousVersion) is false.
 */
export function shouldOpenChangelog(
  previousVersion: string | undefined,
  currentVersion: string,
): boolean {
  const prev = parseVersionParts(previousVersion);
  const cur = parseVersionParts(currentVersion);
  if (!prev || !cur) return false;
  if (cur[0]! !== prev[0]!) return cur[0]! > prev[0]!;
  return cur[1]! > prev[1]!;
}

/**
 * Decide whether an extension update should open a post-update tab at `now`.
 * - During the Holiday Sale UTC window: any strictly increasing version bump
 *   (major, minor, or patch) returns true.
 * - Outside the window: falls back strictly to `shouldOpenChangelog`.
 */
export function shouldOpenUpdateTab(
  previousVersion: string | undefined,
  currentVersion: string,
  now: number = Date.now(),
): boolean {
  if (isHolidaySaleActive(now)) {
    return isStrictlyNewerVersion(previousVersion, currentVersion);
  }
  return shouldOpenChangelog(previousVersion, currentVersion);
}

/**
 * Build the website post-update URL for the given UI locale and version range.
 * Updates landing on 2.0.x open the dedicated `/v2` showcase page; other
 * minor/major releases open `/changelog` with `from` and `to` query params.
 */
export function buildChangelogUrl(
  locale: Locale,
  fromVersion: string,
  toVersion: string,
): string {
  const localePath = websiteLocalePath(locale);
  const to = parseVersionParts(toVersion);
  if (to && to[0] === 2 && to[1] === 0) {
    return `https://www.pie.chat/${localePath}v2`;
  }
  const params = new URLSearchParams({ from: fromVersion, to: toVersion });
  return `https://www.pie.chat/${localePath}changelog?${params.toString()}`;
}

/**
 * Resolve the post-update tab URL to open, or `null` if the update should stay silent.
 * - During the Holiday Sale UTC window: strictly increasing updates (including patch)
 *   open the localized `/holiday` page.
 * - Outside the window: strictly delegates to `shouldOpenChangelog` + `buildChangelogUrl`.
 */
export function buildPostUpdateUrl(
  locale: Locale,
  previousVersion: string | undefined,
  currentVersion: string,
  now: number = Date.now(),
): string | null {
  if (!previousVersion || !shouldOpenUpdateTab(previousVersion, currentVersion, now)) {
    return null;
  }
  if (isHolidaySaleActive(now)) {
    return buildHolidaySaleUrl(locale);
  }
  return buildChangelogUrl(locale, previousVersion, currentVersion);
}
