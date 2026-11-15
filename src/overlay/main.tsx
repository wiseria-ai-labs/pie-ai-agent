// Theme bootstrap before React mounts — same contract as the side panel
// (light | dark | system, "system" leaves data-theme unset so the
// prefers-color-scheme fallback applies). This document is same-origin with
// the side panel, so it reads/writes the same localStorage.
try {
  const m = localStorage.getItem("theme-mode");
  if (m === "light" || m === "dark") {
    document.documentElement.dataset.theme = m;
  }
} catch {
  // localStorage unavailable — system fallback.
}

import { createRoot } from "react-dom/client";
import OverlayApp from "./OverlayApp";
import "./overlay.css";
import { I18nProvider } from "@/lib/i18n";
import { runStartupMigrations } from "@/lib/startup-migrations";
import { MotionProvider } from "@/sidepanel/components/ui/motion";

async function boot() {
  // Same idempotent pipeline the side panel runs: read IDB only after it
  // settles, or a cold profile renders an empty conversation.
  await runStartupMigrations().catch((e) => {
    console.warn("[overlay] startup migrations failed (mounting anyway):", e);
  });
  createRoot(document.getElementById("root")!).render(
    <I18nProvider>
      {/* The side panel's HITL cards are m.* components (no provider = stuck at opacity 0). */}
      <MotionProvider>
        <OverlayApp />
      </MotionProvider>
    </I18nProvider>,
  );
}

void boot();
