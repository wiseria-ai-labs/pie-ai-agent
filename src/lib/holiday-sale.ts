import type { Locale } from "@/lib/i18n/types";
import type { Entitlement } from "@/lib/managed-auth";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import { websiteLocalePath } from "./website-locale";

/** Black Friday & Christmas 2026 Holiday Sale campaign parameters. */
export const HOLIDAY_SALE_CODE = "HOLIDAY50";
export const HOLIDAY_SALE_PERCENT_OFF = 50;

/** Inclusive UTC start: 2026-11-25T00:00:00Z. */
export const HOLIDAY_SALE_START_UTC = Date.UTC(2026, 10, 25, 0, 0, 0);
/** Exclusive UTC end: 2026-12-26T00:00:00Z (covers through 12-25 23:59:59 UTC). */
export const HOLIDAY_SALE_END_UTC = Date.UTC(2026, 11, 26, 0, 0, 0);

/** IDB config key persisting dismissal of the home-screen guidance card. */
export const HOLIDAY_HOME_DISMISSED_KEY = "holiday_sale_2026_home_dismissed";

/** True while `now` falls inside [HOLIDAY_SALE_START_UTC, HOLIDAY_SALE_END_UTC). */
export function isHolidaySaleActive(now: number = Date.now()): boolean {
  return now >= HOLIDAY_SALE_START_UTC && now < HOLIDAY_SALE_END_UTC;
}

/** Build the localized website `/holiday` landing page URL. */
export function buildHolidaySaleUrl(locale: Locale): string {
  return `https://www.pie.chat/${websiteLocalePath(locale)}holiday`;
}

/**
 * Audience eligibility for in-product holiday sale promos:
 * - Eligible: signed-out (null/undefined), plan === "none", or active redemption gift days.
 * - Hidden: active Stripe paid subscribers and blocked (dunning/payment failed) users.
 */
export function isEligibleForHolidayPromo(
  entitlement: Entitlement | null | undefined,
): boolean {
  if (!entitlement) return true;
  if (entitlement.plan === "blocked") return false;
  if (entitlement.plan === "active") {
    return entitlement.subscription?.source === "redemption";
  }
  return true;
}

/**
 * Compute first-year discounted annual price in minor currency units (cents),
 * matching Stripe's half-up discount rounding (`amount - Math.round(amount * 50 / 100)`).
 * Example: 6299 ($62.99) → 3149 ($31.49).
 */
export function holidayAnnualDiscountedAmount(annualAmount: number): number {
  return annualAmount - Math.round((annualAmount * HOLIDAY_SALE_PERCENT_OFF) / 100);
}

/** Discounted monthly equivalent in minor currency units (e.g. 3149 / 12 → 262 = $2.62/mo). */
export function holidayAnnualPerMonthAmount(annualAmount: number): number {
  return Math.round(holidayAnnualDiscountedAmount(annualAmount) / 12);
}

/** Whether the user has dismissed the home-screen holiday sale guidance card. */
export async function isHolidayHomeDismissed(): Promise<boolean> {
  return (await getConfig<boolean>(HOLIDAY_HOME_DISMISSED_KEY)) === true;
}

/** Persist dismissal of the home-screen holiday sale guidance card. */
export async function dismissHolidayHome(): Promise<void> {
  await setConfig(HOLIDAY_HOME_DISMISSED_KEY, true);
}
