import { useEffect, useState } from "react";
import { Bookmark, RotateCcw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { getChange } from "@/lib/browser-data/changes";
import { restoreChangeById } from "@/lib/browser-data/bookmarks";
import { changeLabel } from "@/lib/browser-data/labels";
import type { BrowserChangeRecord, RestoreResult } from "@/lib/browser-data/types";

export interface BrowserChangeRowProps {
  recordId: string;
}

/**
 * F7 footer — the in-conversation undo row ("已整理 86 个书签 · 还原").
 *
 * Reuses the `bookmark_snapshots` change log: the row carries only the record
 * id and the panel re-reads it, so the restore state survives a panel reopen.
 * Restore goes through the same conditional path as Settings → 书签与历史.
 */
export function BrowserChangeRow({ recordId }: BrowserChangeRowProps) {
  const t = useT();
  const [record, setRecord] = useState<BrowserChangeRecord | null | "missing">(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);

  useEffect(() => {
    let alive = true;
    void getChange(recordId).then((r) => {
      if (alive) setRecord(r ?? "missing");
    });
    return () => {
      alive = false;
    };
  }, [recordId]);

  if (record === null) return null;
  if (record === "missing") {
    return (
      <div data-testid="browser-change-row" className="px-1 py-1 text-[11px] text-fg-3">
        {t("browserData.change.gone")}
      </div>
    );
  }

  const restored = !!record.restoredAt;
  const label = changeLabel(record, t);

  const restore = () => {
    setBusy(true);
    void restoreChangeById(record.id).then((res) => {
      setBusy(false);
      setResult(res);
      void getChange(record.id).then((r) => setRecord(r ?? "missing"));
    });
  };

  return (
    <div
      data-testid="browser-change-row"
      className="flex items-center gap-2 rounded-control border border-line bg-surface px-3 py-2"
    >
      <span className="flex shrink-0 text-fg-2">
        <Bookmark size={14} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12.5px] leading-[18px] text-fg-1">{label}</span>
        <span className="truncate text-[11px] leading-[16px] text-fg-3">
          {new Date(record.at).toLocaleTimeString()}
          {restored ? ` · ${t("browserData.page.alreadyRestored")}` : ""}
          {result?.ok
            ? ` · ${
                result.skipped > 0
                  ? t("browserData.page.restoredPartial", {
                      restored: result.restored,
                      skipped: result.skipped,
                    })
                  : t("browserData.page.restored", { count: result.restored })
              }`
            : result && !result.ok
              ? ` · ${t("browserData.page.restoreFailed", { reason: result.error ?? "" })}`
              : ""}
        </span>
      </div>
      {!restored && record.restorable && (
        <button
          type="button"
          onClick={restore}
          disabled={busy}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fg-2 hover:text-fg-1 disabled:opacity-50"
        >
          <RotateCcw size={12} strokeWidth={1.75} />
          {t("common.restore")}
        </button>
      )}
    </div>
  );
}
