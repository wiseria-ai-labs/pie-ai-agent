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
import { onStoreChange } from "@/lib/store-bus";
import { useI18n, type DictKey } from "@/lib/i18n";
import { Button } from "../ui/Button";
import { Collapse } from "../ui/Collapse";
import { ManagedStatusPill } from "../ManagedStatusPill";
import { useAnimatedList } from "../ui/AnimatedList";
import ResearchDetail from "./ResearchDetail";
import ResearchPaywall from "./ResearchPaywall";
import { listSamples, loadSample, sampleToRun, type SampleId } from "./samples";
import { PILL_TONE, statusLabel } from "./status";

export function hasResearchAccess(ent: Entitlement | null | undefined): boolean {
  return ent?.plan === "active" && ent.quota?.research != null;
}

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
  onOpenSubscribe,
}: {
  initialQuestion?: string;
  onPrefillConsumed?: () => void;
  openId?: string;
  onOpenIdConsumed?: () => void;
  onSendToChat?: (markdown: string) => void;
  /** Routes to Settings → Models, the one place that owns sign-in + checkout. */
  onOpenSubscribe?: () => void;
} = {}) {
  const { t, locale } = useI18n();
  const listRef = useAnimatedList<HTMLDivElement>();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<DictKey | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<SampleId | null>(null);
  const [entReady, setEntReady] = useState(false);

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
        setEntReady(true);
        return;
      }
      const cached = getCachedEntitlement(key);
      if (cached) setEnt(cached);
      try {
        const next = await getEntitlement(key);
        if (alive) setEnt(next);
      } catch {
        /* lock is UX-only; missing entitlement → paywall */
      } finally {
        if (alive) setEntReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const unlocked = hasResearchAccess(ent);

  useEffect(() => {
    if (!apiKey || !unlocked) return;
    void loadList(apiKey);
  }, [apiKey, unlocked, loadList]);

  useEffect(() => {
    if (!apiKey) return;
    return onStoreChange("config", (c) => {
      if (!c.id?.startsWith("managed_entitlement_")) return;
      const next = getCachedEntitlement(apiKey);
      if (next) setEnt(next);
    });
  }, [apiKey]);

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
  // Parse on demand: samples are dead weight for unlocked users, and the real
  // reports that replace the placeholders are tens of KB each.
  if (sampleId) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-5" data-testid="research-page">
        <ResearchDetail
          staticRun={sampleToRun(loadSample(sampleId, locale))}
          onBack={() => setSampleId(null)}
        />
      </div>
    );
  }

  if (!entReady && !ent) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-5" data-testid="research-page">
        <div className="text-[12px] text-fg-3">{t("common.loading")}</div>
      </div>
    );
  }

  if (!unlocked) {
    const samples = listSamples(locale);
    return (
      <div className="flex-1 overflow-y-auto px-4 py-5" data-testid="research-page">
        <div className="flex flex-col gap-7 pt-2">
          <ResearchPaywall entitlement={ent} onOpenSubscribe={() => onOpenSubscribe?.()} />
          <div data-testid="research-samples" className="flex flex-col gap-2.5">
            <div className="text-[11px] font-medium leading-4 tracking-[0.02em] text-fg-3">
              {t("research.paywall.samples")}
            </div>
            {samples.map((sample) => (
              <button
                key={sample.id}
                type="button"
                data-testid={`research-sample-${sample.id}`}
                onClick={() => setSampleId(sample.id)}
                className="flex w-full flex-col gap-2.5 rounded-xl border border-line bg-surface px-3.5 pb-3 pt-3.5 text-left transition-colors hover:border-fg-3/60"
              >
                <span className="text-[13px] font-medium leading-[19px] text-fg-1">
                  {sample.title}
                </span>
                {sample.summary && (
                  <span className="line-clamp-3 text-[12px] leading-[18px] text-fg-2">
                    {sample.summary}
                  </span>
                )}
                <span className="flex items-center gap-2 pt-[3px]">
                  <span className="flex-1 font-mono text-[11px] leading-[15px] text-fg-3">
                    {sample.stats
                      ? t("research.paywall.sampleMeta", { ...sample.stats })
                      : ""}
                  </span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-fg-3/70" aria-hidden>
                    <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

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
