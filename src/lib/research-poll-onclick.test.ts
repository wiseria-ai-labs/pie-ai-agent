import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEEPLINK_KEY, parseResearchDetailDeeplink, researchDetailDeeplink } from "./deeplink";
import { RESEARCH_NOTIF_PREFIX } from "./research-notif";

const mocks = vi.hoisted(() => ({
  tryOpenSidePanel: vi.fn(async (): Promise<"opened" | "rejected" | "unsupported"> => "opened"),
  openFallbackPanelWindow: vi.fn(async () => {}),
}));

vi.mock("@/background/panel/sidepanel-probe", () => ({
  tryOpenSidePanel: mocks.tryOpenSidePanel,
}));

vi.mock("@/background/panel/fallback-window", () => ({
  openFallbackPanelWindow: mocks.openFallbackPanelWindow,
}));

const sessionSet = vi.fn(async () => {});

beforeEach(() => {
  mocks.tryOpenSidePanel.mockReset();
  mocks.tryOpenSidePanel.mockResolvedValue("opened");
  mocks.openFallbackPanelWindow.mockReset();
  sessionSet.mockReset();
  sessionSet.mockResolvedValue(undefined);
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
    ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
    storage: {
      ...(globalThis as unknown as { chrome: { storage: Record<string, unknown> } }).chrome.storage,
      session: { set: sessionSet, get: vi.fn(), remove: vi.fn() },
    },
    windows: { getCurrent: vi.fn().mockResolvedValue({ id: 1 }) },
  };
});

describe("handleResearchNotificationClick", () => {
  it("stashes a research-detail deeplink and opens the side panel", async () => {
    const { handleResearchNotificationClick } = await import("@/background/research-onclick");
    await handleResearchNotificationClick(`${RESEARCH_NOTIF_PREFIX}run_42`);
    expect(sessionSet).toHaveBeenCalledWith({ [DEEPLINK_KEY]: researchDetailDeeplink("run_42") });
    expect(mocks.tryOpenSidePanel).toHaveBeenCalledWith({ windowId: 1 });
    expect(parseResearchDetailDeeplink(researchDetailDeeplink("run_42"))).toBe("run_42");
  });

  it("ignores notifications that are not research-done:", async () => {
    const { handleResearchNotificationClick } = await import("@/background/research-onclick");
    await handleResearchNotificationClick("schedule-run:abc");
    expect(sessionSet).not.toHaveBeenCalled();
    expect(mocks.tryOpenSidePanel).not.toHaveBeenCalled();
  });

  it("keeps the deeplink when sidePanel.open is rejected", async () => {
    mocks.tryOpenSidePanel.mockResolvedValue("rejected");
    const { handleResearchNotificationClick } = await import("@/background/research-onclick");
    await handleResearchNotificationClick(`${RESEARCH_NOTIF_PREFIX}run_9`);
    expect(sessionSet).toHaveBeenCalledWith({ [DEEPLINK_KEY]: researchDetailDeeplink("run_9") });
  });

  it("opens a fallback window when side panels are unsupported and still writes the deeplink", async () => {
    mocks.tryOpenSidePanel.mockResolvedValue("unsupported");
    const { handleResearchNotificationClick } = await import("@/background/research-onclick");
    await handleResearchNotificationClick(`${RESEARCH_NOTIF_PREFIX}run_fb`);
    expect(sessionSet).toHaveBeenCalledWith({ [DEEPLINK_KEY]: researchDetailDeeplink("run_fb") });
    expect(mocks.openFallbackPanelWindow).toHaveBeenCalledWith({ windowId: 1 });
  });
});
