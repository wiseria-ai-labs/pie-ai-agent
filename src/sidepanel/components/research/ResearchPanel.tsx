import { useCallback, useEffect, useState } from "react";
import { listInstances } from "@/lib/instances";
import { getCachedEntitlement, getEntitlement } from "@/lib/managed-account";
import {
  listResearch,
  startResearch,
  ResearchError,
  type ResearchRunSummary,
} from "@/lib/managed-research";
import { trackResearchRun } from "@/lib/research-poll";
import { formatResetDate } from "@/lib/managed-format";
import type { Entitlement } from "@/lib/managed-auth";
import { useI18n, type DictKey } from "@/lib/i18n";
import { Button } from "../ui/Button";
import { Collapse } from "../ui/Collapse";
import { ManagedStatusPill } from "../ManagedStatusPill";
import { useAnimatedList } from "../ui/AnimatedList";
import ResearchDetail from "./ResearchDetail";
import { PILL_TONE, statusLabel } from "./status";

const QUESTION_MAX = 2000;
const FOCUS_MAX = 500;

type T = ReturnType<typeof useI18n>["t"];

function sortByCreatedAtDesc(runs: ResearchRunSummary[]): ResearchRunSummary[] {
  return [...runs].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

function formatWeekday(unixSec: number, locale: string): string | null {
  if (!Number.isFinite(unixSec)) return null;
  try {
    return new Date(unixSec * 1000).toLocaleDateString(locale, { weekday: "short" });
  } catch {
    return null;
  }
}

function formatRunTime(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Date(ms).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function startErrorMessage(
  err: unknown,
  t: T,
  locale: string,
  resetAt: number | undefined,
): string {
  if (err instanceof ResearchError) {
    switch (err.code) {
      case "research_quota_exceeded": {
        const date = formatResetDate(resetAt, locale);
        return date
          ? t("research.error.quotaExceeded", { date })
          : t("research.error.quotaExceededNoDate");
      }
      case "research_in_progress":
        return t("research.error.inProgress");
      case "research_unavailable":
        return t("research.error.unavailable");
      case "research_requires_pro":
        return t("research.error.requiresPro");
      default:
        return t("research.error.generic");
    }
  }
  return t("research.error.generic");
}

async function resolveManagedApiKey(): Promise<string | null> {
  try {
    const insts = await listInstances();
    return insts.find((i) => i.provider === "managed" && i.apiKey)?.apiKey ?? null;
  } catch {
    return null;
  }
}

export default function ResearchPanel({
  initialQuestion,
  onPrefillConsumed,
  openId,
  onOpenIdConsumed,
  onSendToChat,
}: {
  initialQuestion?: string;
  onPrefillConsumed?: () => void;
  openId?: string;
  onOpenIdConsumed?: () => void;
  onSendToChat?: (markdown: string) => void;
} = {}) {
  const { t, locale } = useI18n();
  const listRef = useAnimatedList<HTMLDivElement>();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<DictKey | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [focus, setFocus] = useState("");
  const [focusOpen, setFocusOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const loadList = useCallback(async (key: string) => {
    try {
      const rows = await listResearch(key);
      setRuns(sortByCreatedAtDesc(rows));
      setListError(null);
    } catch {
      // Store the key, not t(key): t is a new function every render outside
      // I18nProvider, and listing it as a dep would restart the mount fetch
      // in a tight async loop.
      setListError("research.error.loadFailed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const key = await resolveManagedApiKey();
      if (!alive) return;
      setApiKey(key);
      if (!key) {
        setLoading(false);
        return;
      }
      const cached = getCachedEntitlement(key);
      if (cached) setEnt(cached);
      void getEntitlement(key)
        .then((next) => {
          if (alive) setEnt(next);
        })
        .catch(() => {
          /* quota is decorative; list still works */
        });
      await loadList(key);
    })();
    return () => {
      alive = false;
    };
  }, [loadList]);

  useEffect(() => {
    if (initialQuestion == null) return;
    setQuestion(initialQuestion.slice(0, QUESTION_MAX));
    onPrefillConsumed?.();
  // Consume once per prefill value; parent passes a fresh callback each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  useEffect(() => {
    if (!openId) return;
    setSelectedId(openId);
    onOpenIdConsumed?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  async function handleStart() {
    if (!apiKey || submitting) return;
    const q = question.trim();
    if (!q) return;
    setSubmitting(true);
    setStartError(null);
    try {
      const focusTrim = focus.trim().slice(0, FOCUS_MAX);
      const { id } = await startResearch(apiKey, {
        question: q.slice(0, QUESTION_MAX),
        ...(focusTrim ? { focus: focusTrim } : {}),
      });
      await trackResearchRun(id);
      setQuestion("");
      setFocus("");
      setFocusOpen(false);
      setSelectedId(id);
      void loadList(apiKey);
    } catch (err) {
      setStartError(startErrorMessage(err, t, locale, ent?.quota?.research?.resetAt));
    } finally {
      setSubmitting(false);
    }
  }

  const quota = ent?.quota?.research;
  const remaining = quota ? Math.max(0, quota.weekly - quota.used) : null;
  const weekday = quota ? formatWeekday(quota.resetAt, locale) : null;

  if (selectedId && apiKey) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-5" data-testid="research-page">
        {remaining != null && (
          <QuotaLine remaining={remaining} weekday={weekday} t={t} />
        )}
        <ResearchDetail
          apiKey={apiKey}
          id={selectedId}
          onSendToChat={onSendToChat}
          onBack={() => {
            setSelectedId(null);
            if (apiKey) void loadList(apiKey);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-5" data-testid="research-page">
      <div className="flex flex-col gap-5">
        {remaining != null && (
          <QuotaLine remaining={remaining} weekday={weekday} t={t} />
        )}

        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void handleStart();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="caps text-fg-3">{t("research.questionLabel")}</span>
            <textarea
              data-testid="research-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value.slice(0, QUESTION_MAX))}
              maxLength={QUESTION_MAX}
              rows={3}
              placeholder={t("research.questionPlaceholder")}
              className="w-full resize-y rounded-[10px] border border-line bg-field px-3 py-2 text-[13px] leading-[19px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line focus:outline-none"
            />
          </label>

          <button
            type="button"
            data-testid="research-focus-toggle"
            onClick={() => setFocusOpen((v) => !v)}
            aria-expanded={focusOpen}
            className="self-start text-[12px] text-fg-2 hover:text-fg-1"
          >
            {t("research.focusToggle")}
          </button>
          <Collapse open={focusOpen}>
            <textarea
              data-testid="research-focus"
              value={focus}
              onChange={(e) => setFocus(e.target.value.slice(0, FOCUS_MAX))}
              maxLength={FOCUS_MAX}
              rows={2}
              placeholder={t("research.focusPlaceholder")}
              className="w-full resize-y rounded-[10px] border border-line bg-field px-3 py-2 text-[13px] leading-[19px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line focus:outline-none"
            />
          </Collapse>

          {startError && (
            <div
              data-testid="research-start-error"
              className="rounded-[10px] border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning"
            >
              {startError}
            </div>
          )}

          <Button
            data-testid="research-start"
            type="submit"
            variant="primary"
            size="md"
            loading={submitting}
            disabled={!question.trim()}
          >
            {submitting ? t("research.starting") : t("research.start")}
          </Button>
        </form>

        {listError && (
          <div className="rounded-[10px] border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">
            {t(listError)}
          </div>
        )}

        {loading ? (
          <div className="text-[12px] text-fg-3">{t("common.loading")}</div>
        ) : runs.length === 0 ? (
          <div data-testid="research-empty" className="text-[13px] leading-[19px] text-fg-3">
            {t("research.empty")}
          </div>
        ) : (
          <div ref={listRef} className="flex flex-col gap-1.5">
            {runs.map((row) => (
              <button
                key={row.id}
                type="button"
                data-testid={`research-row-${row.id}`}
                onClick={() => setSelectedId(row.id)}
                className="flex w-full items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-left hover:border-fg-3"
              >
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-fg-1"
                  title={row.question}
                >
                  {row.question}
                </span>
                <ManagedStatusPill tone={PILL_TONE[row.status]} label={statusLabel(row.status, t)} />
                <span className="shrink-0 font-mono text-[11px] text-fg-3">
                  {formatRunTime(row.createdAt, locale)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QuotaLine({
  remaining,
  weekday,
  t,
}: {
  remaining: number;
  weekday: string | null;
  t: T;
}) {
  const text =
    weekday != null
      ? t("research.remaining", { n: remaining, weekday })
      : t("research.remainingNoReset", { n: remaining });
  return (
    <div data-testid="research-quota" className="text-[12px] text-fg-2">
      {text}
    </div>
  );
}
