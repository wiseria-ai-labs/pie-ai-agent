import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import SettingsRoot, { helpCoords } from "./SettingsRoot";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import { listInstances } from "@/lib/instances";
import { _resetForTests } from "@/lib/idb/db";
import { cacheEntitlement, _clearEntitlementCacheForTests } from "@/lib/managed-account";
import { acceptPrivacyPolicy, clearPrivacyConsent } from "@/lib/privacy-consent";
import type { BridgeStatus } from "./bridge-status";

vi.mock("@/lib/cdp-input-enabled", () => ({
  isCdpInputEnabled: vi.fn().mockResolvedValue(false),
  setCdpInputEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn().mockResolvedValue([
    { id: "a", provider: "anthropic", nickname: "One", apiKey: "k", createdAt: 0 },
    { id: "b", provider: "openai", nickname: "Two", apiKey: "k", createdAt: 0 },
  ]),
}));

vi.mock("@/lib/search-provider", () => ({
  ACTIVE_SEARCH_PROVIDER: "tavily",
  getSearchProviderStatus: vi.fn().mockResolvedValue({ configured: true }),
}));

beforeEach(() => {
  (chrome.runtime as unknown as { getManifest: () => { version: string } }).getManifest = () => ({
    version: "9.9.9",
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // The bridge test installs a sendMessage implementation; reset it so the
  // callback-invoking stub doesn't leak into unrelated tests.
  vi.mocked(chrome.runtime.sendMessage).mockReset();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
});

function make(over: Partial<React.ComponentProps<typeof SettingsRoot>> = {}) {
  return {
    themeMode: "system" as const,
    onThemeModeChange: vi.fn(),
    onOpenPage: vi.fn(),
    ...over,
  };
}

describe("SettingsRoot", () => {
  it("renders seven drill-down rows; row-models triggers onOpenPage('models')", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    for (const id of [
      "models",
      "bridge",
      "search",
      "uiLanguage",
      "assistantLanguage",
      "feedback",
      "about",
    ]) {
      expect(screen.getByTestId(`settings-row-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("settings-row-models"));
    expect(p.onOpenPage).toHaveBeenCalledWith("models");
  });

  it("account card opens the account page", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    fireEvent.click(screen.getByTestId("settings-account-card"));
    expect(p.onOpenPage).toHaveBeenCalledWith("account");
  });

  // CDP lives inline in the root page (no sub-page): a switch + a "?" popover.
  it("CDP row is an inline switch, not a drill-down", async () => {
    render(<SettingsRoot {...make()} />);
    expect(screen.queryByTestId("settings-row-cdp")).toBeNull();
    const sw = screen.getByTestId("cdp-switch");
    fireEvent.click(sw);
    await waitFor(() => expect(setCdpInputEnabled).toHaveBeenCalledWith(true));
  });

  it("panel-window row is an inline switch that persists the choice", async () => {
    // The escape hatch for browsers that fool every capability probe. It has to
    // be reversible from the UI — a preference the user can only turn ON would
    // strand anyone who hit it by mistake.
    render(<SettingsRoot {...make()} />);
    fireEvent.click(screen.getByTestId("panel-window-switch"));
    await waitFor(async () => {
      const { getPanelMode } = await import("@/lib/panel-host/panel-mode");
      expect(await getPanelMode()).toBe("window");
    });
  });

  it("interface-scale slider previews while dragging, persists on release, resets to 100%", async () => {
    const { getConfig } = await import("@/lib/idb/config-store");
    // Node ≥25's own (file-less, undefined) localStorage global shadows happy-dom's.
    const ls = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => void ls.set(k, v),
    });
    render(<SettingsRoot {...make()} />);
    const slider = screen.getByTestId("ui-scale-slider") as HTMLInputElement;
    expect(slider.value).toBe("100");
    expect((screen.getByTestId("ui-scale-reset") as HTMLButtonElement).disabled).toBe(true);

    // Drag (input events): zoom follows live, nothing persisted yet.
    fireEvent.input(slider, { target: { value: "120" } });
    expect(document.documentElement.style.zoom).toBe("1.2");
    expect(screen.getByTestId("ui-scale-value").textContent).toBe("120%");
    expect(localStorage.getItem("ui-scale")).toBeNull();

    // Release (native change): written to both stores.
    fireEvent.change(slider);
    expect(localStorage.getItem("ui-scale")).toBe("1.2");
    await waitFor(async () => expect(await getConfig("ui-scale")).toBe(1.2));

    fireEvent.click(screen.getByTestId("ui-scale-reset"));
    expect(document.documentElement.style.zoom).toBe("");
    expect(localStorage.getItem("ui-scale")).toBe("1");
    await waitFor(async () => expect(await getConfig("ui-scale")).toBe(1));
    vi.unstubAllGlobals();
  });

  it("CDP '?' reveals the explainer on hover and hides it on leave", async () => {
    render(<SettingsRoot {...make()} />);
    const help = screen.getByTestId("cdp-help");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(help);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
    fireEvent.mouseLeave(help);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("CDP '?' also reveals the explainer on keyboard focus", async () => {
    render(<SettingsRoot {...make()} />);
    fireEvent.focus(screen.getByTestId("cdp-help"));
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
  });

  // Regression for #298: the root bridge badge polled once at mount and never
  // updated, so a bridge that connected moments later stayed "Not connected".
  it("bridge badge tracks a handshake that completes after mount", async () => {
    vi.useFakeTimers();
    let current: BridgeStatus = { hasPermission: true, ready: false };
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as
        | ((res: unknown) => void)
        | undefined;
      cb?.(current);
      return undefined;
    }) as typeof chrome.runtime.sendMessage);
    render(<SettingsRoot {...make()} />);
    expect(screen.getByTestId("settings-badge-bridge").textContent).toBe(
      "Not connected",
    );

    current = { hasPermission: true, ready: true };
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("settings-badge-bridge").textContent).toContain(
      "Connected",
    );
    vi.useRealTimers();
  });
});

describe("helpCoords", () => {
  const rect = (left: number) => ({ left }) as DOMRect;

  it("left-aligns to the trigger when there is room", () => {
    expect(helpCoords(rect(100), 420)).toEqual({ left: 88, width: 280 });
  });

  it("clamps inside the panel when the trigger sits far right", () => {
    // 420-wide panel: an unclamped popover at left=203 would end at 483 (off-screen).
    expect(helpCoords(rect(215), 420)).toEqual({ left: 132, width: 280 });
  });

  it("shrinks below the min width on a very narrow panel", () => {
    expect(helpCoords(rect(10), 200)).toEqual({ left: 8, width: 184 });
  });

  it("language rows drill into their sub-pages", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    fireEvent.click(screen.getByTestId("settings-row-uiLanguage"));
    expect(p.onOpenPage).toHaveBeenCalledWith("uiLanguage");
    fireEvent.click(screen.getByTestId("settings-row-assistantLanguage"));
    expect(p.onOpenPage).toHaveBeenCalledWith("assistantLanguage");
  });

  it("models row shows a config-count badge", async () => {
    render(<SettingsRoot {...make()} />);
    await waitFor(() => expect(screen.getByTestId("settings-badge-models")).toBeTruthy());
  });

  it("search row shows the configured provider badge", async () => {
    render(<SettingsRoot {...make()} />);
    await waitFor(() => expect(screen.getByTestId("settings-badge-search")).toBeTruthy());
  });

  it("theme segmented has three segments; clicking light fires onThemeModeChange('light')", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    expect(screen.getByTestId("theme-light")).toBeTruthy();
    expect(screen.getByTestId("theme-dark")).toBeTruthy();
    expect(screen.getByTestId("theme-system")).toBeTruthy();
    fireEvent.click(screen.getByTestId("theme-light"));
    expect(p.onThemeModeChange).toHaveBeenCalledWith("light");
  });

  it("about row drills into the About page and badges the manifest version", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    expect(screen.getByTestId("settings-badge-about").textContent).toContain("9.9.9");
    fireEvent.click(screen.getByTestId("settings-row-about"));
    expect(p.onOpenPage).toHaveBeenCalledWith("about");
  });

  it("AccountCard shows pending dot when active subscriber has not consented, and clears on accept", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    await clearPrivacyConsent();

    vi.mocked(listInstances).mockResolvedValueOnce([
      { id: "m1", provider: "managed", nickname: "pro@pie.chat", apiKey: "sk-pro", createdAt: 0 },
    ]);
    // Second call (from memoryBadge effect or bump) also sees the managed instance
    vi.mocked(listInstances).mockResolvedValue([
      { id: "m1", provider: "managed", nickname: "pro@pie.chat", apiKey: "sk-pro", createdAt: 0 },
    ]);
    await cacheEntitlement("sk-pro", {
      plan: "active",
      email: "pro@pie.chat",
      subscription: {
        planName: "Pie Pro",
        currentPeriodEnd: 1750000000,
        cancelAtPeriodEnd: false,
        source: "stripe",
      },
      quota: null,
      models: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            plan: "active",
            email: "pro@pie.chat",
            subscription: {
              planName: "Pie Pro",
              currentPeriodEnd: 1750000000,
              cancelAtPeriodEnd: false,
              source: "stripe",
            },
            quota: null,
            models: [],
            privacyConsent: false,
          }),
          { status: 200 },
        ),
      ),
    );

    render(<SettingsRoot {...make()} />);
    expect(await screen.findByTestId("settings-account-privacy-dot")).toBeTruthy();

    await act(async () => {
      await acceptPrivacyPolicy("account_page");
    });

    await waitFor(() =>
      expect(screen.queryByTestId("settings-account-privacy-dot")).toBeNull(),
    );
    vi.unstubAllGlobals();
  });
});

describe("SettingsRoot holiday promo banner", () => {
  it("shows promo below AccountCard inside window for BYOK user and routes CTA to account page", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 26, 12, 0, 0));
    vi.mocked(listInstances).mockResolvedValue([
      { id: "a", provider: "anthropic", nickname: "One", apiKey: "k", createdAt: 0 },
    ]);

    const p = make();
    render(<SettingsRoot {...p} />);
    const banner = await screen.findByTestId("holiday-settings-banner");
    expect(banner).toBeTruthy();
    fireEvent.click(screen.getByTestId("holiday-promo-cta"));
    expect(p.onOpenPage).toHaveBeenCalledWith("account");
  });

  it("hides promo for active Stripe subscribers even inside holiday window", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 26, 12, 0, 0));
    vi.mocked(listInstances).mockResolvedValue([
      { id: "m1", provider: "managed", nickname: "pro@pie.chat", apiKey: "sk-stripe", createdAt: 0 },
    ]);
    await cacheEntitlement("sk-stripe", {
      plan: "active",
      email: "pro@pie.chat",
      subscription: {
        planName: "Pie Pro",
        currentPeriodEnd: 1799000000,
        cancelAtPeriodEnd: false,
        source: "stripe",
      },
      quota: null,
      models: [],
    });

    render(<SettingsRoot {...make()} />);
    await act(async () => {});
    expect(screen.queryByTestId("holiday-settings-banner")).toBeNull();
  });

  it("hides promo outside holiday window", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 11, 26, 0, 0, 0));
    vi.mocked(listInstances).mockResolvedValue([
      { id: "a", provider: "anthropic", nickname: "One", apiKey: "k", createdAt: 0 },
    ]);

    render(<SettingsRoot {...make()} />);
    await act(async () => {});
    expect(screen.queryByTestId("holiday-settings-banner")).toBeNull();
  });
});
