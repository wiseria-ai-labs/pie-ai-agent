import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import type { Entitlement } from "@/lib/managed-auth";
import {
  HOLIDAY_SALE_CODE,
  HOLIDAY_SALE_PERCENT_OFF,
  HOLIDAY_SALE_START_UTC,
  HOLIDAY_SALE_END_UTC,
  isHolidaySaleActive,
  buildHolidaySaleUrl,
  isEligibleForHolidayPromo,
  holidayAnnualDiscountedAmount,
  holidayAnnualPerMonthAmount,
  isHolidayHomeDismissed,
  dismissHolidayHome,
} from "./holiday-sale";

describe("holiday-sale campaign constants & UTC window", () => {
  it("exports contract constants", () => {
    expect(HOLIDAY_SALE_CODE).toBe("HOLIDAY50");
    expect(HOLIDAY_SALE_PERCENT_OFF).toBe(50);
    expect(HOLIDAY_SALE_START_UTC).toBe(Date.UTC(2026, 10, 25, 0, 0, 0));
    expect(HOLIDAY_SALE_END_UTC).toBe(Date.UTC(2026, 11, 26, 0, 0, 0));
  });

  it("enforces exact inclusive-start / exclusive-end UTC window boundaries", () => {
    expect(isHolidaySaleActive(HOLIDAY_SALE_START_UTC - 1)).toBe(false);
    expect(isHolidaySaleActive(HOLIDAY_SALE_START_UTC)).toBe(true);
    expect(isHolidaySaleActive(Date.UTC(2026, 11, 10, 12, 0, 0))).toBe(true);
    expect(isHolidaySaleActive(HOLIDAY_SALE_END_UTC - 1)).toBe(true);
    expect(isHolidaySaleActive(HOLIDAY_SALE_END_UTC)).toBe(false);
  });
});

describe("buildHolidaySaleUrl", () => {
  it("builds localized /holiday URLs for all 6 locales", () => {
    expect(buildHolidaySaleUrl("en")).toBe("https://www.pie.chat/holiday");
    expect(buildHolidaySaleUrl("zh-CN")).toBe("https://www.pie.chat/zh-Hans/holiday");
    expect(buildHolidaySaleUrl("zh-TW")).toBe("https://www.pie.chat/zh-Hant/holiday");
    expect(buildHolidaySaleUrl("es-419")).toBe("https://www.pie.chat/es-419/holiday");
    expect(buildHolidaySaleUrl("ja")).toBe("https://www.pie.chat/ja/holiday");
    expect(buildHolidaySaleUrl("pt-BR")).toBe("https://www.pie.chat/pt-BR/holiday");
  });
});

describe("isEligibleForHolidayPromo", () => {
  it("allows signed-out (null / undefined), plan=none, and active redemption users", () => {
    expect(isEligibleForHolidayPromo(null)).toBe(true);
    expect(isEligibleForHolidayPromo(undefined)).toBe(true);

    const noneEnt: Entitlement = {
      plan: "none",
      email: "u@pie.chat",
      subscription: null,
      quota: null,
      models: [],
    };
    expect(isEligibleForHolidayPromo(noneEnt)).toBe(true);

    const redemptionEnt: Entitlement = {
      plan: "active",
      email: "u@pie.chat",
      subscription: {
        planName: "Pie Pro",
        currentPeriodEnd: 1799000000,
        cancelAtPeriodEnd: true,
        source: "redemption",
      },
      quota: null,
      models: [],
    };
    expect(isEligibleForHolidayPromo(redemptionEnt)).toBe(true);
  });

  it("hides promo for active Stripe subscribers and blocked accounts", () => {
    const stripeEnt: Entitlement = {
      plan: "active",
      email: "pro@pie.chat",
      subscription: {
        planName: "Pie Pro",
        currentPeriodEnd: 1799000000,
        cancelAtPeriodEnd: false,
        source: "stripe",
        interval: "month",
      },
      quota: null,
      models: [],
    };
    expect(isEligibleForHolidayPromo(stripeEnt)).toBe(false);

    const blockedEnt: Entitlement = {
      plan: "blocked",
      email: "blocked@pie.chat",
      subscription: {
        planName: "Pie Pro",
        currentPeriodEnd: 1799000000,
        cancelAtPeriodEnd: false,
        source: "stripe",
      },
      quota: null,
      models: [],
    };
    expect(isEligibleForHolidayPromo(blockedEnt)).toBe(false);
  });
});

describe("holiday annual half-up pricing math", () => {
  it("matches Stripe half-up rounding ($62.99 → $31.49, ≈ $2.62/mo)", () => {
    expect(holidayAnnualDiscountedAmount(6299)).toBe(3149);
    expect(holidayAnnualPerMonthAmount(6299)).toBe(262);
    expect(holidayAnnualDiscountedAmount(6200)).toBe(3100);
    expect(holidayAnnualPerMonthAmount(6200)).toBe(258);
  });
});

describe("home guidance dismissal persistence", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("defaults to false and persists true after dismissHolidayHome()", async () => {
    expect(await isHolidayHomeDismissed()).toBe(false);
    await dismissHolidayHome();
    expect(await isHolidayHomeDismissed()).toBe(true);
  });
});
