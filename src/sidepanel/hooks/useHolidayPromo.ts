import { useCallback, useEffect, useRef, useState } from "react";
import { getPieAccount } from "@/lib/pie-account";
import { getCachedEntitlement, getEntitlement } from "@/lib/managed-account";
import { onStoreChange } from "@/lib/store-bus";
import {
  HOLIDAY_HOME_DISMISSED_KEY,
  dismissHolidayHome,
  isEligibleForHolidayPromo,
  isHolidayHomeDismissed,
  isHolidaySaleActive,
} from "@/lib/holiday-sale";

export interface HolidayPromoState {
  /** True when the sale is active and the user is confirmed eligible. */
  eligible: boolean;
  /** True when eligible and the home-screen guidance card has not been dismissed. */
  showHomeBanner: boolean;
  /** Persist dismissal of the home-screen guidance card. */
  dismissHome: () => Promise<void>;
}

const ENTITLEMENT_PREFIX = "managed_entitlement_";

/**
 * Reactive holiday-sale visibility hook shared across sidepanel surfaces.
 * Fails closed until account + entitlement resolve so active Stripe subscribers
 * never experience a promo flash, and caches per-apiKey lookups to avoid network spam.
 */
export function useHolidayPromo(): HolidayPromoState {
  const active = isHolidaySaleActive();
  const [eligible, setEligible] = useState(false);
  const [homeDismissed, setHomeDismissed] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fetchedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      setEligible(false);
      setHomeDismissed(true);
      return;
    }

    let alive = true;
    void (async () => {
      const [acct, dismissed] = await Promise.all([
        getPieAccount().catch(() => null),
        isHolidayHomeDismissed().catch(() => false),
      ]);
      if (!alive) return;
      setHomeDismissed(dismissed);

      if (!acct) {
        fetchedForRef.current = null;
        setEligible(true);
        return;
      }

      const cached = getCachedEntitlement(acct.apiKey);
      if (cached) {
        setEligible(isEligibleForHolidayPromo(cached));
        return;
      }

      // Hold off until entitlement resolves so Stripe subscribers never see a flash.
      setEligible(false);
      if (fetchedForRef.current === acct.apiKey) return;
      fetchedForRef.current = acct.apiKey;
      try {
        const fresh = await getEntitlement(acct.apiKey);
        if (!alive) return;
        setEligible(isEligibleForHolidayPromo(fresh));
      } catch {
        // Offline / error: stay false rather than risking a false positive.
      }
    })();

    return () => {
      alive = false;
    };
  }, [active, nonce]);

  useEffect(() => {
    if (!active) return;
    const bump = () => setNonce((n) => n + 1);
    const offs = [
      onStoreChange("instances", bump),
      onStoreChange("config", (c) => {
        if (
          c.id === undefined ||
          c.id === HOLIDAY_HOME_DISMISSED_KEY ||
          c.id.startsWith(ENTITLEMENT_PREFIX)
        ) {
          bump();
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [active]);

  const dismissHome = useCallback(async () => {
    setHomeDismissed(true);
    await dismissHolidayHome().catch(() => {});
  }, []);

  return {
    eligible: active && eligible,
    showHomeBanner: active && eligible && !homeDismissed,
    dismissHome,
  };
}
