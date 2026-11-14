import { useState } from "react";
import { Bookmark, Check, ExternalLink } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { BrowserResultEntry } from "@/lib/browser-data/types";
import { createBookmark } from "@/lib/browser-data/bookmarks";

export interface BrowserResultsCardProps {
  kind: "history" | "bookmarks";
  query?: string;
  total: number;
  entries: BrowserResultEntry[];
}

/** `MM-DD HH:mm` in the device locale. */
function stamp(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function openUrl(url: string): void {
  // Panel-safe: an in-panel <a> would navigate the panel itself.
  void chrome.tabs.create({ url });
}

/**
 * F6 — clickable result list for search_history / search_bookmarks.
 *
 * Rows open in a new tab. History rows carry a one-click "add to bookmarks"
 * action: that is a direct user gesture (same semantics as create_bookmark),
 * so it executes immediately and shows up in the change log.
 *
 * Favicon: the first letter of the hostname (as in the design board) — no
 * network request, works offline, never leaks the query to a favicon service.
 */
export function BrowserResultsCard({ kind, total, entries }: BrowserResultsCardProps) {
  const t = useT();
  const [added, setAdded] = useState<Record<string, "ok" | "error">>({});
  const isHistory = kind === "history";

  const addBookmark = async (entry: BrowserResultEntry) => {
    const res = await createBookmark({ url: entry.url, title: entry.title });
    setAdded((cur) => ({ ...cur, [entry.url]: res.ok ? "ok" : "error" }));
  };

  return (
    <div
      data-testid="browser-results-card"
      className="flex flex-col gap-1 rounded-control border border-line bg-surface p-2.5"
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="caps text-fg-3">
          {t(isHistory ? "browserData.results.historyTitle" : "browserData.results.bookmarksTitle")}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-fg-3">
          {t("browserData.results.total", { count: total })}
        </span>
      </div>

      {entries.map((entry, i) => {
        const host = hostOf(entry.url);
        const letter = (host[0] ?? "?").toUpperCase();
        const state = added[entry.url];
        return (
          <div
            key={`${entry.url}-${i}`}
            className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-field ${
              i === 0 && isHistory ? "bg-field" : ""
            }`}
          >
            <span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-chip bg-surface-deep text-[11px] font-medium text-fg-2"
            >
              {letter}
            </span>
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                openUrl(entry.url);
              }}
              aria-label={`${t("browserData.results.open")}: ${entry.title || entry.url}`}
              className="flex min-w-0 flex-1 flex-col"
            >
              <span className="truncate text-[12.5px] leading-[18px] text-fg-1">{entry.title || entry.url}</span>
              <span className="truncate text-[11px] leading-[16px] text-fg-3">
                {[
                  host,
                  entry.lastVisit ? stamp(entry.lastVisit) : "",
                  entry.visits ? t("browserData.results.visits", { count: entry.visits }) : "",
                  entry.folder ?? "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </a>
            {isHistory ? (
              <button
                type="button"
                onClick={() => void addBookmark(entry)}
                disabled={state === "ok"}
                aria-label={t("browserData.results.addBookmark")}
                title={
                  state === "error"
                    ? t("browserData.results.needBookmarksPermission")
                    : t("browserData.results.addBookmark")
                }
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-chip text-fg-3 hover:text-fg-1 disabled:opacity-60"
              >
                {state === "ok" ? <Check size={13} strokeWidth={2} /> : <Bookmark size={13} strokeWidth={1.75} />}
              </button>
            ) : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center text-fg-3">
                <ExternalLink size={13} strokeWidth={1.75} />
              </span>
            )}
          </div>
        );
      })}

      {total > entries.length && (
        <div className="px-1 pt-1 text-[11px] text-fg-3">
          {t("browserData.results.more", { count: total - entries.length })}
        </div>
      )}
      {Object.values(added).includes("error") && (
        <div className="px-1 pt-1 text-[11px] text-warning">
          {t("browserData.results.needBookmarksPermission")}
        </div>
      )}
    </div>
  );
}
