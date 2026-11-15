import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Brain, Globe, Lock, Pin, Clock, User, Sliders, Target, Trash2 } from "lucide-react";
import { useT, type DictKey } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import { Switch } from "@/sidepanel/components/ui/Switch";
import {
  exportMemory,
  getMemoryProfile,
  getMemorySettings,
  getMemorySnapshot,
  getMemoryState,
  listMemoryEntries,
} from "@/lib/memory/store";
import { getMemoryAccessState, type MemoryAccessState } from "@/lib/memory/access";
import {
  syncClearAllMemory,
  syncDeleteMemoryEntries,
  syncMemoryFromCloud,
  syncRestoreMemorySnapshot,
  syncSetMemorySettings,
  syncUpdateMemoryEntry,
} from "@/lib/memory/sync";
import MemoryPaywall from "./MemoryPaywall";
import { nextCompactionAt } from "@/lib/memory/compact";
import {
  grantBrowserDataPermission,
  hasBrowserDataPermission,
} from "@/lib/browser-data/permissions";
import {
  LONG_TERM_KINDS,
  MEMORY_KINDS,
  MEMORY_MAX_CHARS,
  type MemoryEntry,
  type MemoryKind,
} from "@/lib/memory/types";

const ICONS: Record<MemoryKind, typeof User> = {
  about: User,
  preference: Sliders,
  contact: Pin,
  site: Globe,
  ongoing: Target,
  recent: Clock,
};

const ROW_ICON = { size: 16, strokeWidth: 1.75 } as const;

function fmtDate(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 设计板 F14「下次精简 12-01」——只要日期。 */
function fmtDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pb-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-fg-3">
      {children}
    </div>
  );
}

/** 类别标签走 i18n（模型侧 prompt 用 types.ts 里的固定中文标签）。 */
const KIND_TITLE_KEY: Record<MemoryKind, DictKey> = {
  about: "settings.memory.kinds.about",
  preference: "settings.memory.kinds.preference",
  contact: "settings.memory.kinds.contact",
  site: "settings.memory.kinds.site",
  ongoing: "settings.memory.kinds.ongoing",
  recent: "settings.memory.kinds.recent",
};

/** F14 — 设置 · 记忆（整页）。分类行点进去是 F15 的列表视图（同一组件内切换）。
 *  `onOpenSession` 由 App 注入：F15 条目来源点回原对话（切到那个 session）。 */
export default function MemoryPage({
  onOpenSession,
  onOpenSubscribe,
}: {
  onOpenSession?: (sessionId: string) => void;
  onOpenSubscribe?: () => void;
}) {
  const t = useT();
  const [access, setAccess] = useState<MemoryAccessState | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [historySource, setHistorySource] = useState(false);
  const [historyPerm, setHistoryPerm] = useState(false);
  const [lastSummary, setLastSummary] = useState<
    | { at: number; added: number; updated: number; merged: number; expired: number; deleted: number }
    | undefined
  >();
  const [lastCompactedAt, setLastCompactedAt] = useState<number | undefined>();
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [profileText, setProfileText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<MemoryKind | "root">("root");
  const [domainDraft, setDomainDraft] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useMemo(
    () => async () => {
      const [accessState, es, settings, state, snap, profile] = await Promise.all([
        getMemoryAccessState({ fetchIfUncached: false }),
        listMemoryEntries({ includeExpired: true }),
        getMemorySettings(),
        getMemoryState(),
        getMemorySnapshot(),
        getMemoryProfile(),
      ]);
      setAccess(accessState);
      setEntries(es);
      setEnabled(settings.enabled);
      setExcluded(settings.excludedDomains);
      setHistorySource(settings.historySource === true);
      setHistoryPerm(await hasBrowserDataPermission("history"));
      setLastSummary(state.lastSummary);
      setLastCompactedAt(state.lastCompactedAt);
      setHasSnapshot(!!snap || state.hasCloudSnapshot === true);
      setProfileText(profile.text);
      setLoaded(true);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void reload();
    // 另一侧（SW 的整理 / 对话里的 remember）改库时刷新。
    const off = onStoreChange("memory", () => {
      if (alive) void reload();
    });

    // 打开记忆页时强制刷新订阅态，并将本机镜像与云端最新版对齐。
    void (async () => {
      try {
        const fresh = await getMemoryAccessState({ refresh: true });
        if (!alive) return;
        if (fresh.mode !== "local_dev" && fresh.apiKey) {
          await syncMemoryFromCloud({ force: true }).catch(() => null);
        }
        if (alive) await reload();
      } catch {
        // 离线或服务端暂不可用：回退保留本地镜像
      }
    })();

    return () => {
      alive = false;
      off();
    };
  }, [reload]);

  if (!loaded && access === null) {
    return (
      <div className="py-6 text-center text-[12px] text-fg-3" data-testid="memory-page-loading">
        {t("common.loading")}
      </div>
    );
  }

  if (access?.mode === "locked") {
    return (
      <MemoryPaywall
        entitlement={access.entitlement}
        {...(onOpenSubscribe ? { onOpenSubscribe } : {})}
      />
    );
  }

  const isReadOnly = access?.mode === "readonly_expired";
  const live = entries.filter((e) => e.validTo === undefined);
  const byKind = (k: MemoryKind) => live.filter((e) => e.kind === k);
  const longCount = live.filter((e) => LONG_TERM_KINDS.includes(e.kind)).length;
  const recentCount = live.length - longCount;
  const usedChars = live.reduce((n, e) => n + e.title.length + e.body.length, 0);

  const toggle = async (next: boolean) => {
    if (isReadOnly) return;
    setActionError(null);
    setEnabled(next);
    try {
      const saved = await syncSetMemorySettings({ enabled: next });
      setEnabled(saved.enabled);
    } catch (err) {
      setEnabled(!next);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 浏览历史来源（spec §5.3）。打开时必须在这个点击手势里申请 history 可选权限
   * ——复用书签历史线的授权 helper，不自己调 chrome.permissions。
   * 关掉只是停止使用历史，不回收权限（search_history 等还在用它）。
   */
  const toggleHistorySource = async (next: boolean) => {
    if (isReadOnly) return;
    setActionError(null);
    if (!next) {
      setHistorySource(false);
      await syncSetMemorySettings({ historySource: false });
      return;
    }
    const granted = await grantBrowserDataPermission("history");
    setHistoryPerm(granted);
    if (!granted) return; // 用户拒绝 → 开关保持关
    setHistorySource(true);
    await syncSetMemorySettings({ historySource: true });
  };

  const addDomain = async () => {
    if (isReadOnly) return;
    const d = domainDraft.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
    if (!d || excluded.includes(d)) return;
    const prev = excluded;
    const next = [...excluded, d];
    setActionError(null);
    setExcluded(next);
    setDomainDraft("");
    try {
      await syncSetMemorySettings({ excludedDomains: next });
    } catch (err) {
      setExcluded(prev);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeDomain = async (d: string) => {
    if (isReadOnly) return;
    const prev = excluded;
    const next = excluded.filter((x) => x !== d);
    setActionError(null);
    setExcluded(next);
    try {
      await syncSetMemorySettings({ excludedDomains: next });
    } catch (err) {
      setExcluded(prev);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const doExport = async () => {
    const data = await exportMemory();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pie-memory.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const doClear = async () => {
    setActionError(null);
    try {
      await syncClearAllMemory();
      setConfirmingClear(false);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const doRestore = async () => {
    if (isReadOnly) return;
    setActionError(null);
    try {
      await syncRestoreMemorySnapshot();
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  if (view !== "root") {
    return (
      <MemoryList
        kind={view}
        entries={byKind(view)}
        readOnly={isReadOnly}
        onBack={() => setView("root")}
        onChanged={reload}
        {...(onOpenSession ? { onOpenSession } : {})}
      />
    );
  }

  return (
    <section className="flex flex-col gap-5" data-testid="memory-page">
      {isReadOnly && (
        <div
          data-testid="memory-readonly-banner"
          className="flex flex-col gap-2 rounded-card border border-warning-line bg-warning-tint p-3.5"
        >
          <div className="text-[13px] font-semibold text-fg-1">
            {t("settings.memory.readonly.title")}
          </div>
          <p className="text-[12px] leading-[18px] text-fg-2">
            {t("settings.memory.readonly.desc")}
          </p>
          {onOpenSubscribe && (
            <button
              type="button"
              data-testid="memory-readonly-resubscribe"
              onClick={onOpenSubscribe}
              className="w-fit rounded-control bg-fg-1 px-3 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90"
            >
              {t("settings.memory.readonly.resubscribe")}
            </button>
          )}
        </div>
      )}
      {actionError && (
        <div className="rounded-control border border-warning-line bg-warning-tint px-3 py-2 text-[11.5px] text-warning">
          {actionError}
        </div>
      )}
      {/* 顶部卡：开着吗 / 用了多少 / 最近一次整理做了什么 */}
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
        <div className="flex items-center gap-2.5">
          <Brain {...ROW_ICON} className="text-fg-2" />
          <span className="flex-1 text-[13.5px] font-semibold text-fg-1">
            {t("settings.memory.heroTitle")}
          </span>
          <Switch
            testId="memory-switch"
            checked={enabled}
            disabled={isReadOnly}
            onChange={(v) => void toggle(v)}
          />
        </div>
        <p className="text-[12px] leading-[18px] text-fg-2">{t("settings.memory.heroDesc")}</p>

        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-[11.5px] text-fg-2">
            <span>{t("settings.memory.usedLabel")}</span>
            <span className="font-mono text-[11px] text-fg-1">
              {t("settings.memory.usedChars", {
                used: String(usedChars),
                max: String(MEMORY_MAX_CHARS),
              })}
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-field">
            <i
              className="block h-full bg-accent"
              style={{ width: `${Math.min(100, (usedChars / MEMORY_MAX_CHARS) * 100)}%` }}
            />
          </div>
          <div className="flex gap-3 text-[11px] text-fg-3">
            <span>{t("settings.memory.longTerm", { count: String(longCount) })}</span>
            <span>{t("settings.memory.recent", { count: String(recentCount) })}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line pt-2.5 text-[11.5px] text-fg-2">
          <Clock size={14} strokeWidth={1.75} className="text-fg-3" />
          {lastSummary ? (
            <span className="flex-1">
              {t("settings.memory.lastRun", {
                time: fmtDate(lastSummary.at),
                added: String(lastSummary.added),
                updated: String(lastSummary.updated),
                merged: String(lastSummary.merged),
              })}
            </span>
          ) : (
            <span className="flex-1">{t("settings.memory.neverRun")}</span>
          )}
        </div>
        {/* 设计板 F14「下次精简 12-01」——例行精简在每月 1 号，容量到 90% 会提前 */}
        <div className="flex items-center justify-between text-[11px] text-fg-3">
          <span>{t("settings.memory.nextCompact", { date: fmtDay(nextCompactionAt()) })}</span>
          {lastCompactedAt && (
            <span className="font-mono">
              {t("settings.memory.lastCompact", { time: fmtDate(lastCompactedAt) })}
            </span>
          )}
        </div>
        {profileText && (
          <details className="text-[11.5px] text-fg-2">
            <summary className="cursor-pointer text-fg-3">{t("settings.memory.profileTitle")}</summary>
            <p className="mt-1 whitespace-pre-wrap leading-[18px]">{profileText}</p>
          </details>
        )}
      </div>

      {/* 记忆内容 */}
      <div>
        <GroupLabel>{t("settings.memory.contentTitle")}</GroupLabel>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {MEMORY_KINDS.map((k) => {
            const Icon = ICONS[k];
            const n = byKind(k).length;
            return (
              <button
                key={k}
                type="button"
                data-testid={`memory-kind-${k}`}
                onClick={() => setView(k)}
                className="flex h-[46px] w-full items-center gap-3 border-t border-line px-3.5 text-left first:border-t-0 hover:bg-field"
              >
                <span className="shrink-0 text-fg-2">
                  <Icon {...ROW_ICON} />
                </span>
                <span className="flex-1 text-[13px] font-medium text-fg-1">
                  {t(KIND_TITLE_KEY[k])}
                </span>
                <span className="flex items-center gap-1 text-[12px] text-fg-3">
                  {k === "contact" && <Lock size={12} strokeWidth={1.75} />}
                  {n}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 来源：对话 + 浏览历史（历史只读网站与标题，权限与书签历史线共用） */}
      <div>
        <GroupLabel>{t("settings.memory.sourcesTitle")}</GroupLabel>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex min-h-[46px] items-center gap-3 px-3.5 py-2">
            <span className="flex-1 text-[13px] font-medium text-fg-1">
              {t("settings.memory.sourceChat")}
              <small className="block text-[11px] font-normal text-fg-3">
                {t("settings.memory.sourceChatDesc")}
              </small>
            </span>
            <Switch
              testId="memory-source-chat"
              checked={enabled}
              disabled={isReadOnly}
              onChange={() => void toggle(!enabled)}
            />
          </div>
          <div className="flex min-h-[46px] items-center gap-3 border-t border-line px-3.5 py-2">
            <span className="flex-1 text-[13px] font-medium text-fg-1">
              {t("settings.memory.sourceHistory")}
              <small className="block text-[11px] font-normal text-fg-3">
                {t("settings.memory.sourceHistoryDesc")}
              </small>
              {historySource && !historyPerm && (
                <small className="mt-0.5 block text-[11px] text-warning">
                  {t("settings.memory.historyPermissionNeeded")}
                </small>
              )}
            </span>
            <Switch
              testId="memory-source-history"
              checked={historySource}
              disabled={isReadOnly}
              onChange={(v) => void toggleHistorySource(v)}
            />
          </div>
        </div>
      </div>

      {/* 隐私与成本 */}
      <div>
        <GroupLabel>{t("settings.memory.privacyTitle")}</GroupLabel>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex flex-col gap-2 px-3.5 py-2.5">
            <span className="text-[13px] font-medium text-fg-1">
              {t("settings.memory.excludedTitle")}
              <small className="block text-[11px] font-normal text-fg-3">
                {t("settings.memory.excludedDesc")}
              </small>
            </span>
            {excluded.length === 0 ? (
              <span className="text-[11.5px] text-fg-3">{t("settings.memory.excludedEmpty")}</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {excluded.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => void removeDomain(d)}
                    className="flex h-[22px] items-center gap-1.5 rounded-chip bg-field px-2 text-[11.5px] text-fg-2 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
                    title={t("settings.memory.excludedRemove")}
                  >
                    {d} ×
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                data-testid="memory-domain-input"
                value={domainDraft}
                disabled={isReadOnly}
                onChange={(e) => setDomainDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addDomain();
                }}
                placeholder={t("settings.memory.excludedPlaceholder")}
                className="h-[30px] flex-1 rounded-control border border-line bg-field px-2.5 text-[12.5px] text-fg-1 placeholder:text-fg-3 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                data-testid="memory-domain-add"
                onClick={() => void addDomain()}
                disabled={isReadOnly || !domainDraft.trim()}
                className="shrink-0 rounded-control bg-accent px-2.5 py-1.5 text-[12px] font-medium text-canvas disabled:opacity-50"
              >
                {t("settings.memory.add")}
              </button>
            </div>
          </div>
          <div className="flex min-h-[46px] items-center gap-3 border-t border-line px-3.5 py-2">
            <span className="flex-1 text-[13px] font-medium text-fg-1">
              {t("settings.memory.modelTitle")}
              <small className="block text-[11px] font-normal text-fg-3">
                {t("settings.memory.modelDesc")}
              </small>
            </span>
            <span className="text-[12px] text-fg-3">{t("settings.memory.modelValue")}</span>
          </div>
        </div>
      </div>

      {/* 底部动作 */}
      <div className="flex flex-wrap items-center gap-4 px-1 text-[12px]">
        <button type="button" data-testid="memory-export" onClick={() => void doExport()} className="text-fg-2 hover:text-fg-1">
          {t("settings.memory.export")}
        </button>
        {!isReadOnly && hasSnapshot && (
          <button
            type="button"
            data-testid="memory-restore"
            onClick={() => void doRestore()}
            className="text-fg-2 hover:text-fg-1"
          >
            {t("settings.memory.restoreSnapshot")}
          </button>
        )}
        {confirmingClear ? (
          <span className="flex items-center gap-2">
            <span className="text-[11.5px] text-warning">{t("settings.memory.clearConfirm")}</span>
            <button
              type="button"
              data-testid="memory-clear-confirm"
              onClick={() => void doClear()}
              className="font-medium text-warning underline underline-offset-2"
            >
              {t("settings.memory.clearAction")}
            </button>
            <button type="button" onClick={() => setConfirmingClear(false)} className="text-fg-3 hover:text-fg-1">
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="memory-clear"
            onClick={() => setConfirmingClear(true)}
            className="text-warning hover:opacity-80"
          >
            {t("settings.memory.clearAll")}
          </button>
        )}
        {!loaded && <span className="text-[11.5px] text-fg-3">{t("common.loading")}</span>}
      </div>
    </section>
  );
}

/** F15 — 某一类记忆的列表：搜索、就地编辑、删除。 */
function MemoryList({
  kind,
  entries,
  readOnly = false,
  onBack,
  onChanged,
  onOpenSession,
}: {
  kind: MemoryKind;
  entries: MemoryEntry[];
  readOnly?: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const visible = entries
    .filter((e) => e.validTo === undefined)
    .filter((e) => {
      if (!query.trim()) return true;
      const hay = `${e.title} ${e.body} ${e.tags.join(" ")}`.toLowerCase();
      return hay.includes(query.trim().toLowerCase());
    });

  const startEdit = (e: MemoryEntry) => {
    if (readOnly) return;
    setEditing(e.id);
    setDraft(e.body || e.title);
  };

  const save = async (id: string) => {
    if (readOnly) return;
    const cur = entries.find((e) => e.id === id);
    if (!cur) return;
    await syncUpdateMemoryEntry(id, { title: cur.title, body: draft.trim() || cur.title });
    setEditing(null);
    await onChanged();
  };

  const remove = async (id: string) => {
    if (readOnly) return;
    await syncDeleteMemoryEntries([id]);
    if (editing === id) setEditing(null);
    await onChanged();
  };

  return (
    <section className="flex flex-col gap-3" data-testid={`memory-list-${kind}`}>
      <button type="button" onClick={onBack} className="flex w-fit items-center gap-1 text-[12px] text-fg-2 hover:text-fg-1">
        <ArrowLeft size={14} strokeWidth={1.75} />
        {t("settings.memory.title")}
      </button>
      <div className="text-[13.5px] font-semibold text-fg-1">{t(KIND_TITLE_KEY[kind])}</div>

      <div className="flex h-8 items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-fg-3">
        <input
          data-testid="memory-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.memory.searchPlaceholder")}
          className="flex-1 bg-transparent text-fg-1 placeholder:text-fg-3 focus:outline-none"
        />
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {visible.length === 0 ? (
          <div className="px-3.5 py-3 text-[12px] text-fg-3">{t("settings.memory.empty")}</div>
        ) : (
          visible.map((e) => {
            const masked = e.encrypted === true && !revealed.has(e.id);
            const isEditing = editing === e.id;
            return (
              <div key={e.id} className="flex flex-col gap-1.5 border-t border-line px-3.5 py-2.5 first:border-t-0">
                {isEditing ? (
                  <textarea
                    data-testid="memory-edit"
                    value={draft}
                    onChange={(ev) => setDraft(ev.target.value)}
                    rows={3}
                    className="w-full resize-y rounded-control border border-accent bg-surface px-2.5 py-2 text-[13px] leading-[19px] text-fg-1 focus:outline-none"
                  />
                ) : (
                  <div className="text-[13px] leading-[19px] text-fg-1">
                    {masked ? (
                      <button
                        type="button"
                        onClick={() => setRevealed((s) => new Set(s).add(e.id))}
                        className="flex items-center gap-1.5 text-fg-3"
                      >
                        <Lock size={12} strokeWidth={1.75} />
                        {t("settings.memory.masked")}
                      </button>
                    ) : (
                      e.body || e.title || t("settings.memory.decryptFailed")
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-3">
                  {e.pinned && (
                    <span className="rounded-chip border border-line px-1.5 text-[10px]">
                      {t("settings.memory.pinnedTag")}
                    </span>
                  )}
                  <span>{fmtDate(e.updatedAt)}</span>
                  {e.useCount > 0 && (
                    <span>{t("settings.memory.usedTimes", { count: String(e.useCount) })}</span>
                  )}
                  {e.sourceSessionId &&
                    (onOpenSession ? (
                      <button
                        type="button"
                        data-testid={`memory-source-${e.id}`}
                        onClick={() => onOpenSession(e.sourceSessionId!)}
                        title={e.sourceTitle}
                        className="underline underline-offset-2 hover:text-fg-1"
                      >
                        {t("settings.memory.sourceFrom")}
                      </button>
                    ) : (
                      <span>{t("settings.memory.sourceFrom")}</span>
                    ))}
                  <span className="flex-1" />
                  {!readOnly && (isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void remove(e.id)}
                        className="flex items-center gap-1 text-warning"
                      >
                        <Trash2 size={12} strokeWidth={1.75} />
                        {t("common.delete")}
                      </button>
                      <button
                        type="button"
                        data-testid="memory-save"
                        onClick={() => void save(e.id)}
                        className="rounded-control bg-accent px-2 py-0.5 text-[11px] font-medium text-canvas"
                      >
                        {t("common.save")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid={`memory-edit-${e.id}`}
                      onClick={() => startEdit(e)}
                      className="text-fg-2 underline underline-offset-2 hover:text-fg-1"
                    >
                      {t("common.edit")}
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
