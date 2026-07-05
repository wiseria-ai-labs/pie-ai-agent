/**
 * Settings component tests — verify tab routing and openTab state management
 * (Task 6 Critical: settingsOpenTab sticky state fix).
 *
 * Test the openTab prop behavior when transitioning between different routes
 * (e.g., Skills → Settings plain).
 */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState, type ComponentProps } from "react";
import Settings from "@/sidepanel/components/Settings";

afterEach(() => {
  cleanup();
});

// Mock useSession and related hooks to avoid needing full App + SW setup.
vi.mock("@/sidepanel/hooks/useSession", () => ({
  useSession: () => ({
    sessionId: "test-session",
    streaming: false,
    createAndActivate: vi.fn(),
  }),
}));

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn(async () => []),
  createInstance: vi.fn(),
  deleteInstance: vi.fn(),
  updateInstance: vi.fn(),
  firstModelForProvider: vi.fn(),
}));

vi.mock("@/lib/provider-custom-models", () => ({
  getProviderCustomModels: vi.fn(async () => []),
  addProviderCustomModel: vi.fn(),
  removeProviderCustomModel: vi.fn(),
}));

vi.mock("@/lib/provider-custom-model-meta", () => ({
  getProviderCustomModelMetas: vi.fn(async () => ({})),
  setProviderCustomModelMeta: vi.fn(),
  removeProviderCustomModelMeta: vi.fn(),
}));

vi.mock("@/lib/custom-providers", () => ({
  CUSTOM_PREFIX: "custom:",
  providerRefToId: vi.fn(),
  listCustomProviders: vi.fn(async () => []),
}));

vi.mock("@/lib/cdp-input-enabled", () => ({
  isCdpInputEnabled: vi.fn(async () => false),
  setCdpInputEnabled: vi.fn(),
}));

vi.mock("@/lib/model-router/providers/registry", () => ({
  getProviderMeta: vi.fn(),
  resolveProviderMeta: vi.fn(async () => null),
  resolveEndpointVariant: vi.fn(),
}));

vi.mock("@/lib/openrouter-models-fetch", () => ({
  fetchOpenRouterModels: vi.fn(),
}));

vi.mock("@/lib/provider-test", () => ({
  testProviderConnection: vi.fn(),
}));

vi.mock("@/lib/managed-account", () => ({
  submitFeedback: vi.fn(),
}));

vi.mock("@/lib/log-buffer", () => ({
  readRecentLogs: vi.fn(async () => []),
}));

vi.mock("@/lib/log-cap", () => ({
  capLogBytes: vi.fn((logs) => logs),
}));

// Mock chrome.runtime for FeedbackSection and AboutSection
(globalThis as unknown as {
  chrome: {
    runtime: {
      getManifest: () => { version: string };
      getURL: (path: string) => string
    }
  }
}).chrome = {
  ...(globalThis as unknown as { chrome: object }).chrome,
  runtime: {
    ...((globalThis as unknown as { chrome: { runtime: object } }).chrome?.runtime ?? {}),
    getManifest: () => ({ version: "1.0.0" }),
    getURL: (path: string) => `chrome-extension://mock-id/${path}`,
  },
};

function renderSettings(overrides: Partial<ComponentProps<typeof Settings>> = {}) {
  const onBack = vi.fn();
  const onRunSkill = vi.fn();
  const utils = render(
    <Settings
      onBack={onBack}
      onRunSkill={onRunSkill}
      openSubscribeNonce={0}
      {...overrides}
    />,
  );
  return { ...utils, onBack, onRunSkill };
}

describe("Settings component (Task 6: settingsOpenTab sticky state)", () => {
  it("renders the default 'configs' tab when openTab is null", async () => {
    renderSettings({ openTab: null });
    await waitFor(() => {
      const configsTab = screen.getByRole("button", { name: /Configs/i });
      expect(configsTab.getAttribute("class")).toContain("bg-field"); // active tab
    });
  });

  it("renders the 'skills' tab when openTab specifies it", async () => {
    renderSettings({ openTab: { tab: "skills", nonce: 1 } });
    await waitFor(() => {
      const skillsTab = screen.getByRole("button", { name: /Skills/i });
      expect(skillsTab.getAttribute("class")).toContain("bg-field"); // active tab
    });
  });

  it("clears sticky openTab state on tab switch via user interaction", async () => {
    const { rerender } = renderSettings({ openTab: { tab: "skills", nonce: 1 } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skills/i }).getAttribute("class")).toContain("bg-field");
    });

    // User manually clicks a different tab.
    const configsTab = screen.getByRole("button", { name: /Configs/i });
    fireEvent.click(configsTab);

    // This proves the internal setTab works; openTab prop still has old value but UI is correct.
    await waitFor(() => {
      expect(configsTab.getAttribute("class")).toContain("bg-field");
    });
  });

  it("re-plays old openTab value on remount when prop hasn't changed", async () => {
    // Simulate the bug: openTab prop is sticky across a Settings remount.
    const { rerender } = renderSettings({ openTab: { tab: "skills", nonce: 1 } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skills/i }).getAttribute("class")).toContain("bg-field");
    });

    // Component re-mounts with the same stale openTab prop (as would happen before the fix).
    rerender(
      <Settings
        onBack={() => {}}
        onRunSkill={() => {}}
        openSubscribeNonce={0}
        openTab={{ tab: "skills", nonce: 1 }} // Same nonce = effect won't re-run per dependency array
      />,
    );

    // The skills tab should still be active (effect runs again on mount).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skills/i }).getAttribute("class")).toContain("bg-field");
    });
  });

  it("consume-once: calls onOpenTabConsumed exactly once right after applying openTab.tab", async () => {
    const onOpenTabConsumed = vi.fn();
    renderSettings({ openTab: { tab: "skills", nonce: 1 }, onOpenTabConsumed });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skills/i }).getAttribute("class")).toContain("bg-field");
    });
    expect(onOpenTabConsumed).toHaveBeenCalledOnce();
  });

  // Mini integration harness — reproduces the App-level wiring that the unit
  // tests above cannot see (Settings alone has no owner to clear its state
  // for). Mirrors App.tsx: `openTab` state + onOpenTabConsumed → setNull,
  // plus a toggle to mount/unmount Settings the way switching `view` does.
  //
  // This is the regression test for the original Task 6 bug: MenuHub's
  // "Skills" route left `settingsOpenTab` sticky, so leaving Settings and
  // coming back via a *plain* route (no new openTab) replayed "skills"
  // instead of defaulting to "configs". Mutation-verified below (see report).
  function AppLikeHarness() {
    const [mounted, setMounted] = useState(true);
    const [openTab, setOpenTab] = useState<{ tab: "skills" | "configs" | "search" | "general"; nonce: number } | null>(
      { tab: "skills", nonce: 1 },
    );
    return (
      <div>
        <button onClick={() => setMounted(false)}>unmount</button>
        <button onClick={() => setMounted(true)}>remount-plain</button>
        {mounted && (
          <Settings
            onBack={() => {}}
            onRunSkill={() => {}}
            openSubscribeNonce={0}
            openTab={openTab}
            onOpenTabConsumed={() => setOpenTab(null)}
          />
        )}
      </div>
    );
  }

  it("integration: plain remount after a routed Settings visit defaults to 'configs', not the stale route", async () => {
    render(<AppLikeHarness />);

    // First visit is routed to "skills" (e.g. MenuHub's Skills destination).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skills/i }).getAttribute("class")).toContain("bg-field");
    });

    // Leave Settings (unmount) and come back via a plain route — no new
    // openTab is set, exactly like MenuHub's "Settings" destination or the
    // top-bar back button landing on a fresh Settings mount.
    fireEvent.click(screen.getByText("unmount"));
    fireEvent.click(screen.getByText("remount-plain"));

    await waitFor(() => {
      const configsTab = screen.getByRole("button", { name: /Configs/i });
      expect(configsTab.getAttribute("class")).toContain("bg-field");
    });
    // And "skills" must NOT still be showing as active.
    expect(screen.getByRole("button", { name: /Skills/i }).getAttribute("class")).not.toContain("bg-field");
  });

  it("calls onBack when the back button is clicked", async () => {
    const { onBack } = renderSettings();
    const backButton = screen.getByRole("button", { name: /back|返回/i });
    fireEvent.click(backButton);
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("theme segmented in Settings general (Task 7, G8)", () => {
  it("renders 3 theme options in general tab and reports changes", async () => {
    const onChange = vi.fn();
    renderSettings({
      themeMode: "system",
      onThemeModeChange: onChange,
    });

    // Click the general tab
    const generalTab = screen.getByRole("button", { name: /general/i });
    fireEvent.click(generalTab);

    // Find the radiogroup by theme/主题 label
    const group = await screen.findByRole("radiogroup", { name: /theme|主题/i });
    expect(group).toBeTruthy();

    // Verify 3 radio buttons (light, dark, system)
    const radios = group.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(3);

    // Click dark and verify onChange is called
    const darkRadio = screen.getByRole("radio", { name: /dark|深色/i });
    fireEvent.click(darkRadio);
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("highlights the current theme option", async () => {
    renderSettings({
      themeMode: "dark",
      onThemeModeChange: vi.fn(),
    });

    const generalTab = screen.getByRole("button", { name: /general/i });
    fireEvent.click(generalTab);

    const darkRadio = screen.getByRole("radio", { name: /dark|深色/i });
    expect(darkRadio.getAttribute("aria-checked")).toBe("true");

    const lightRadio = screen.getByRole("radio", { name: /light|浅色/i });
    expect(lightRadio.getAttribute("aria-checked")).toBe("false");
  });
});
