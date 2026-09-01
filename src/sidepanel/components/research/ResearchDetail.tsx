import { useEffect, useState } from "react";
import { cancelResearch, getResearch, type ResearchPhase, type ResearchRun } from "@/lib/managed-research";
import { downloadResearchMarkdown, researchDownloadFilename } from "@/lib/research-download";
import { useI18n } from "@/lib/i18n";
import { Button } from "../ui/Button";
import { ManagedStatusPill } from "../ManagedStatusPill";
import MarkdownContent from "../Markdown";
import { PILL_TONE, TERMINAL_STATUSES, statusLabel } from "./status";

export const DETAIL_POLL_MS = 5000;

const PHASES: ResearchPhase[] = ["plan", "gather", "synthesize"];

type T = ReturnType<typeof useI18n>["t"];

function phaseLabel(phase: ResearchPhase, t: T): string {
  switch (phase) {
    case "plan":
      return t("research.phasePlan");
    case "gather":
      return t("research.phaseGather");
    case "synthesize":
      return t("research.phaseSynthesize");
  }
}

/** Page-open poll: GET /research/:id every 5s; cleanup on unmount (leave page). */
export function useResearchRun(apiKey: string, id: string): {
  run: ResearchRun | null;
  loadError: string | null;
  setRun: (run: ResearchRun) => void;
  setLoadError: (msg: string | null) => void;
} {
  const { t } = useI18n();
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let handle: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (handle != null) {
        clearInterval(handle);
        handle = undefined;
      }
    };
    const tick = async () => {
      try {
        const next = await getResearch(apiKey, id);
        if (stopped) return;
        setRun(next);
        setLoadError(null);
        if (TERMINAL_STATUSES.has(next.status)) stop();
      } catch {
        if (!stopped) setLoadError(t("research.error.loadFailed"));
      }
    };
    void tick();
    handle = setInterval(() => {
      void tick();
    }, DETAIL_POLL_MS);
    return () => {
      stopped = true;
      stop();
    };
  // t is stable under I18nProvider; listing it would restart the poll on
  // every render when the hook is used outside the provider (tests).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, id]);

  return { run, loadError, setRun, setLoadError };
}

function DoneReport({
  run,
  t,
  onSendToChat,
}: {
  run: ResearchRun;
  t: T;
  /** Absent for the built-in samples — nothing to send into a live chat there. */
  onSendToChat?: (markdown: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {run.report && (
        <div data-testid="research-report" className="text-[13px] text-fg-1">
          <div className="caps mb-2 text-fg-3">{t("research.report")}</div>
          <MarkdownContent content={run.report} />
        </div>
      )}
      {run.report && (
        <div className="flex flex-wrap items-center gap-2">
          {onSendToChat && (
            <Button
              data-testid="research-send-to-chat"
              variant="secondary"
              size="sm"
              onClick={() => onSendToChat(run.report!)}
            >
              {t("research.sendToChat")}
            </Button>
          )}
          <Button
            data-testid="research-download"
            variant="ghost"
            size="sm"
            onClick={() => {
              void downloadResearchMarkdown(
                researchDownloadFilename(run.question),
                run.report!,
              ).catch((e) => {
                const m = e instanceof Error ? e.message : String(e);
                if (/canceled|cancelled/i.test(m)) return;
                console.warn("[research] download failed:", e);
              });
            }}
          >
            {t("research.download")}
          </Button>
        </div>
      )}
      {run.references && run.references.length > 0 && (
        <div data-testid="research-references">
          <div className="caps mb-2 text-fg-3">{t("research.references")}</div>
          <ul className="flex flex-col gap-1.5">
            {run.references.map((ref) => {
              const title = ref.title || ref.url;
              return (
                <li key={ref.n} className="text-[12px] leading-[18px] text-fg-2">
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline decoration-accent/40 hover:decoration-accent"
                  >
                    [{ref.n}] {title} — {ref.url}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function StaticResearchDetail({ run, onBack }: { run: ResearchRun; onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4" data-testid="research-detail">
      <button
        type="button"
        data-testid="research-back"
        onClick={onBack}
        className="self-start text-[12px] text-fg-2 hover:text-fg-1"
      >
        {t("research.backToList")}
      </button>
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 text-[14px] font-medium leading-[20px] text-fg-1">
            {run.question}
          </div>
          <ManagedStatusPill tone={PILL_TONE[run.status]} label={statusLabel(run.status, t)} />
        </div>
      </div>
      {run.status === "done" && <DoneReport run={run} t={t} />}
    </div>
  );
}

export default function ResearchDetail({
  apiKey,
  id,
  onBack,
  onSendToChat,
  staticRun,
}: {
  apiKey?: string;
  id?: string;
  onBack: () => void;
  onSendToChat?: (markdown: string) => void;
  /** Preloaded run — skip fetch/poll/cancel (built-in sample reports). */
  staticRun?: ResearchRun;
}) {
  if (staticRun) {
    return <StaticResearchDetail run={staticRun} onBack={onBack} />;
  }
  return <LiveResearchDetail apiKey={apiKey!} id={id!} onBack={onBack} onSendToChat={onSendToChat} />;
}

function LiveResearchDetail({
  apiKey,
  id,
  onBack,
  onSendToChat,
}: {
  apiKey: string;
  id: string;
  onBack: () => void;
  onSendToChat?: (markdown: string) => void;
}) {
  const { t } = useI18n();
  const { run, loadError, setRun, setLoadError } = useResearchRun(apiKey, id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelResearch(apiKey, id);
      const next = await getResearch(apiKey, id);
      setRun(next);
      setConfirmCancel(false);
    } catch {
      setLoadError(t("research.error.generic"));
    } finally {
      setCancelling(false);
    }
  }

  const live = run?.status === "queued" || run?.status === "running";

  return (
    <div className="flex flex-col gap-4" data-testid="research-detail">
      <button
        type="button"
        data-testid="research-back"
        onClick={onBack}
        className="self-start text-[12px] text-fg-2 hover:text-fg-1"
      >
        {t("research.backToList")}
      </button>

      {loadError && (
        <div
          data-testid="research-detail-error"
          className="rounded-[10px] border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning"
        >
          {loadError}
        </div>
      )}

      {!run && !loadError && (
        <div className="text-[12px] text-fg-3">{t("common.loading")}</div>
      )}

      {run && (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 text-[14px] font-medium leading-[20px] text-fg-1">
                {run.question}
              </div>
              <ManagedStatusPill tone={PILL_TONE[run.status]} label={statusLabel(run.status, t)} />
            </div>
          </div>

          {run.status === "queued" && (
            <div className="text-[12px] text-fg-2">{t("research.waiting")}</div>
          )}

          {run.status === "running" && (
            <div className="flex flex-col gap-2" data-testid="research-progress">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]">
                {PHASES.map((phase, i) => {
                  const current = run.phase ?? "plan";
                  const idx = PHASES.indexOf(current);
                  const done = i < idx;
                  const active = phase === current;
                  const cls = active ? "font-medium text-accent" : done ? "text-success" : "text-fg-3";
                  return (
                    <span key={phase} className="inline-flex items-center gap-1.5">
                      {i > 0 && <span className="text-fg-3">·</span>}
                      <span data-testid={`research-phase-${phase}`} className={cls}>
                        {phaseLabel(phase, t)}
                      </span>
                    </span>
                  );
                })}
              </div>
              <div data-testid="research-sources" className="text-[12px] text-fg-2">
                {t("research.sourcesFound", { n: run.sourcesFound })}
              </div>
            </div>
          )}

          {run.status === "done" && <DoneReport run={run} t={t} onSendToChat={onSendToChat} />}

          {run.status === "failed_system" && (
            <div data-testid="research-failed" className="text-[13px] leading-[19px] text-fg-1">
              {t("research.failedSystem")}
            </div>
          )}

          {run.status === "cancelled" && (
            <div data-testid="research-cancelled" className="text-[13px] leading-[19px] text-fg-2">
              {t("research.cancelled")}
            </div>
          )}

          {live && (
            <div className="flex items-center gap-2">
              {confirmCancel ? (
                <>
                  <Button
                    data-testid="research-cancel-confirm"
                    variant="danger"
                    size="sm"
                    loading={cancelling}
                    onClick={() => void handleCancel()}
                  >
                    {t("research.confirmCancel")}
                  </Button>
                  <Button
                    data-testid="research-cancel-keep"
                    variant="ghost"
                    size="sm"
                    disabled={cancelling}
                    onClick={() => setConfirmCancel(false)}
                  >
                    {t("research.keepGoing")}
                  </Button>
                </>
              ) : (
                <Button
                  data-testid="research-cancel"
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmCancel(true)}
                >
                  {t("research.cancel")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
