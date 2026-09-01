import { tryOpenSidePanel } from "@/background/panel/sidepanel-probe";
import { openFallbackPanelWindow } from "@/background/panel/fallback-window";
import { DEEPLINK_KEY, researchDetailDeeplink } from "@/lib/deeplink";
import { RESEARCH_NOTIF_PREFIX } from "@/lib/research-notif";

/**
 * chrome.notifications.onClicked for `research-done:<id>`.
 * Stashes a one-shot deeplink the panel consumes (open research detail), then
 * tries to open/focus the side panel — same gesture constraint as schedules.
 * Never throws.
 */
export async function handleResearchNotificationClick(notificationId: string): Promise<void> {
  try {
    if (!notificationId.startsWith(RESEARCH_NOTIF_PREFIX)) return;
    const id = notificationId.slice(RESEARCH_NOTIF_PREFIX.length);
    if (!id) return;

    await chrome.storage.session.set({ [DEEPLINK_KEY]: researchDetailDeeplink(id) });

    try {
      const win = await chrome.windows.getCurrent({ populate: false });
      if (typeof win.id !== "number") throw new Error("no numeric window id");
      const outcome = await tryOpenSidePanel({ windowId: win.id });
      if (outcome === "rejected") throw new Error("sidePanel.open rejected");
      if (outcome === "unsupported") {
        await openFallbackPanelWindow({ windowId: win.id });
      }
    } catch {
      // Deeplink stays in session storage; the panel consumes it on next open.
    }
  } catch {
    // Outer guard — this listener must never crash the SW.
  }
}
