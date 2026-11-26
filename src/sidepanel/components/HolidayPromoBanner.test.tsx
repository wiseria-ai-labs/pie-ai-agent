import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import HolidayPromoBanner, { HolidayCheckoutCodeCallout } from "./HolidayPromoBanner";
import ResearchPaywall from "./research/ResearchPaywall";
import MemoryPaywall from "./settings/pages/MemoryPaywall";
import { HOLIDAY_SALE_CODE, HOLIDAY_SALE_START_UTC, HOLIDAY_SALE_END_UTC } from "@/lib/holiday-sale";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HolidayPromoBanner", () => {
  it("renders home variant with copyable HOLIDAY50 pill, CTA, dismiss, and /holiday link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onCta = vi.fn();
    const onDismiss = vi.fn();

    render(
      <HolidayPromoBanner
        variant="home"
        ctaLabel="Claim 50% Off"
        onCta={onCta}
        onDismiss={onDismiss}
        showDetailsLink
      />,
    );

    expect(screen.getByTestId("holiday-promo-banner")).toBeTruthy();
    expect(screen.getByText(HOLIDAY_SALE_CODE)).toBeTruthy();
    const details = screen.getByTestId("holiday-promo-details") as HTMLAnchorElement;
    expect(details.getAttribute("href")).toBe("https://www.pie.chat/holiday");

    await act(async () => {
      fireEvent.click(screen.getByTestId("holiday-code-copy"));
    });
    expect(writeText).toHaveBeenCalledWith(HOLIDAY_SALE_CODE);
    expect(screen.getByText("Copied")).toBeTruthy();

    fireEvent.click(screen.getByTestId("holiday-promo-cta"));
    expect(onCta).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("holiday-promo-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders compact variant and checkout callout", () => {
    render(
      <>
        <HolidayPromoBanner variant="compact" description="Custom promo line" />
        <HolidayCheckoutCodeCallout />
      </>,
    );
    expect(screen.getByText("Custom promo line")).toBeTruthy();
    expect(screen.getByTestId("holiday-checkout-code-callout")).toBeTruthy();
  });
});

describe("Paywall holiday promo visibility", () => {
  const inside = HOLIDAY_SALE_START_UTC + 10_000;
  const outside = HOLIDAY_SALE_END_UTC;

  it("ResearchPaywall & MemoryPaywall show promo inside window for eligible users and hide outside", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inside);

    const { rerender } = render(<ResearchPaywall entitlement={null} onOpenSubscribe={vi.fn()} />);
    expect(screen.getByTestId("holiday-paywall-banner")).toBeTruthy();
    expect(screen.getByText(HOLIDAY_SALE_CODE)).toBeTruthy();

    const blockedEnt: Entitlement = {
      plan: "blocked",
      email: "b@pie.chat",
      subscription: { planName: "Pie Pro", currentPeriodEnd: null, cancelAtPeriodEnd: false, source: "stripe" },
      quota: null,
      models: [],
    };
    rerender(<ResearchPaywall entitlement={blockedEnt} onOpenSubscribe={vi.fn()} />);
    expect(screen.queryByTestId("holiday-paywall-banner")).toBeNull();

    cleanup();
    render(<MemoryPaywall entitlement={null} onOpenSubscribe={vi.fn()} />);
    expect(screen.getByTestId("holiday-paywall-banner")).toBeTruthy();

    vi.setSystemTime(outside);
    cleanup();
    render(<MemoryPaywall entitlement={null} onOpenSubscribe={vi.fn()} />);
    expect(screen.queryByTestId("holiday-paywall-banner")).toBeNull();
  });
});
