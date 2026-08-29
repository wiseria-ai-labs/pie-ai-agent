import type { ResearchStatus } from "@/lib/managed-research";
import type { useI18n } from "@/lib/i18n";
import type { StatusTone } from "../ManagedStatusPill";

type T = ReturnType<typeof useI18n>["t"];

export const PILL_TONE: Record<ResearchStatus, StatusTone> = {
  queued: "neutral",
  running: "warning",
  done: "success",
  cancelled: "neutral",
  failed_system: "warning",
};

export const TERMINAL_STATUSES: ReadonlySet<ResearchStatus> = new Set([
  "done",
  "cancelled",
  "failed_system",
]);

export function statusLabel(status: ResearchStatus, t: T): string {
  switch (status) {
    case "queued":
      return t("research.statusQueued");
    case "running":
      return t("research.statusRunning");
    case "done":
      return t("research.statusDone");
    case "cancelled":
      return t("research.statusCancelled");
    case "failed_system":
      return t("research.statusFailed");
  }
}
