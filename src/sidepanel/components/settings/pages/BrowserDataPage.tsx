import { useCallback, useEffect, useState } from "react";
import { Bookmark, History, Info, RotateCcw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { STORES } from "@/lib/idb/db";
import { onStoreChange } from "@/lib/store-bus";
import type { BrowserChangeRecord, BrowserDataDomain } from "@/lib/browser-data/types";
import {
  grantBrowserDataPermission,
  hasBrowserDataPermission,
  revokeBrowserDataPermission,
} from "@/lib/browser-data/permissions";
import { listChanges } from "@/lib/browser-data/changes";
import { restoreChangeById } from "@/lib/browser-data/bookmarks";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function Group({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-card border border-line bg-surface">{children}</div>;
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pb-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-fg-3">
      {children}
    </div>
  );
}

function smallButton(label: string, onClick: () => void, disabled = false) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fg-2 hover:text-fg-1 disabled:opacity-50"
    >
      {label}
    </button>
  );
}

/**
 * F17 — Settings → 书签与历史.
 *
 * Reads IDB / permission state directly (the panel is a first-class context for
 * both), so there is no SW RPC hop. Granting still has to happen here because
 * chrome.permissions.request needs the user's click.
 */
export default function BrowserDataPage() {
  const t = useT();
  const [perms, setPerms] = useState<Record<BrowserDataDomain, boolean> | null>(null);
  const [changes, setChanges] = useState<BrowserChangeRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshPerms = useCallback(() => {
    void Promise.all([hasBrowserDataPermission("bookmarks"), hasBrowserDataPermission("history")]).then(
      ([bookmarks, history]) => setPerms({ bookmarks, history }),
    );
  }, []);

  const refreshChanges = useCallback(() => {
    void listChanges().then(setChanges);
  }, []);

  useEffect(() => {
    refreshPerms();
    refreshChanges();
    const off = onStoreChange(STORES.bookmarkSnapshots, () => refreshChanges());
    // Permission changes can also come from Chrome's own UI or another panel.
    const onPermChange = () => refreshPerms();
    chrome.permissions?.onAdded?.addListener(onPermChange);
    chrome.permissions?.onRemoved?.addListener(onPermChange);
    return () => {
      off();
      chrome.permissions?.onAdded?.removeListener(onPermChange);
      chrome.permissions?.onRemoved?.removeListener(onPermChange);
    };
  }, [refreshPerms, refreshChanges]);

  const grant = (domain: BrowserDataDomain) => {
    setBusy(domain);
    void grantBrowserDataPermission(domain).then((ok) => {
      setBusy(null);
      refreshPerms();
      if (!ok) setNotice(t("browserData.page.grantDenied"));
    });
  };

  const revoke = (domain: BrowserDataDomain) => {
    setBusy(domain);
    void revokeBrowserDataPermission(domain).then(() => {
      setBusy(null);
      refreshPerms();
    });
  };

  const restore = (rec: BrowserChangeRecord) => {
    setBusy(rec.id);
    void restoreChangeById(rec.id).then((res) => {
      setBusy(null);
      refreshChanges();
      setNotice(
        res.ok
          ? res.skipped > 0
            ? t("browserData.page.restoredPartial", { restored: res.restored, skipped: res.skipped })
            : t("browserData.page.restored", { count: res.restored })
          : t("browserData.page.restoreFailed", { reason: res.error ?? "" }),
      );
    });
  };

  const rows: Array<{ domain: BrowserDataDomain; icon: React.ReactNode; label: string; sub: string }> = [
    {
      domain: "bookmarks",
      icon: <Bookmark {...ICON} />,
      label: t("browserData.page.bookmarksLabel"),
      sub: t("browserData.page.bookmarksSub"),
    },
    {
      domain: "history",
      icon: <History {...ICON} />,
      label: t("browserData.page.historyLabel"),
      sub: t("browserData.page.historySub"),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <GroupLabel>{t("browserData.page.permissionsGroup")}</GroupLabel>
        <Group>
          {rows.map((row) => {
            const granted = perms?.[row.domain] ?? false;
            return (
              <div
                key={row.domain}
                data-testid={`browser-data-perm-${row.domain}`}
                className="flex min-h-[56px] items-center gap-3 border-t border-line px-3.5 py-2 first:border-t-0"
              >
                <span className="shrink-0 text-fg-2">{row.icon}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium text-fg-1">{row.label}</span>
                  <span className="text-[11px] leading-[16px] text-fg-3">{row.sub}</span>
                </div>
                {granted && (
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
                    {t("browserData.page.granted")}
                  </span>
                )}
                {granted
                  ? smallButton(t("browserData.page.revoke"), () => revoke(row.domain), busy === row.domain)
                  : smallButton(t("browserData.page.grant"), () => grant(row.domain), busy === row.domain)}
              </div>
            );
          })}
        </Group>
      </div>

      <div>
        <GroupLabel>{t("browserData.page.changesGroup")}</GroupLabel>
        <Group>
          {changes.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-fg-3">{t("browserData.page.changesEmpty")}</div>
          ) : (
            changes.map((rec) => (
              <div
                key={rec.id}
                data-testid={`browser-change-${rec.id}`}
                className="flex min-h-[52px] items-center gap-3 border-t border-line px-3.5 py-2 first:border-t-0"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className={`truncate text-[13px] ${rec.restorable ? "text-fg-1" : "text-fg-2"}`}>
                    {rec.summary}
                  </span>
                  <span className="text-[11px] leading-[16px] text-fg-3">
                    {new Date(rec.at).toLocaleString()}
                    {rec.restorable ? "" : ` · ${t("browserData.page.irreversible")}`}
                    {rec.restoredAt ? ` · ${t("browserData.page.alreadyRestored")}` : ""}
                  </span>
                </div>
                {rec.restorable && !rec.restoredAt && (
                  <button
                    type="button"
                    onClick={() => restore(rec)}
                    disabled={busy === rec.id}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fg-2 hover:text-fg-1 disabled:opacity-50"
                  >
                    <RotateCcw size={12} strokeWidth={1.75} />
                    {t("common.restore")}
                  </button>
                )}
              </div>
            ))
          )}
        </Group>
      </div>

      {notice && (
        <div className="flex items-start gap-1.5 px-1 text-[11px] leading-[17px] text-fg-2" role="status">
          <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-3" />
          <span>{notice}</span>
        </div>
      )}
      <div className="flex items-start gap-1.5 px-1 text-[11px] leading-[17px] text-fg-3">
        <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>{t("browserData.page.hint")}</span>
      </div>
    </div>
  );
}
