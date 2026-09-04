import { useEffect, useState } from "react";
import type { ResearchPhase, ResearchRun, ResearchSubStatus } from "@/lib/managed-research";
import { useI18n } from "@/lib/i18n";
import { isHttpUrl } from "./http-url";

type T = ReturnType<typeof useI18n>["t"];

const PHASES: ResearchPhase[] = ["plan", "gather", "synthesize"];

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

/** mm:ss，超过一小时进位到 h:mm:ss。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  if (m < 60) return `${String(m).padStart(2, "0")}:${s}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`;
}

/** 每秒重算一次的已用时长；startedAt 缺失（列表未加载）时返回 null。 */
function useElapsed(startedAt: string | undefined, live: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !startedAt) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [live, startedAt]);
  if (!startedAt) return null;
  const t0 = Date.parse(startedAt);
  if (!Number.isFinite(t0)) return null;
  return formatElapsed(now - t0);
}

/* 状态点。active 的外环用全局 pie-pulse keyframe（scale .55→2, opacity .5→0），
   页面上只此一处循环动画；prefers-reduced-motion 由 index.css 全局塌缩。 */
function PhaseDot({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-success-tint">
        <CheckIcon className="text-success" />
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-line">
        <span className="size-[5px] rounded-full bg-line" />
      </span>
    );
  }
  return (
    <span className="relative flex size-[18px] shrink-0 items-center justify-center rounded-full border border-accent-line bg-accent-tint">
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-accent"
        style={{ animation: "pie-pulse 2000ms cubic-bezier(.4,0,.6,1) infinite" }}
      />
      <span className="relative size-[7px] rounded-full bg-accent" />
    </span>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={className} aria-hidden>
      <path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SubIcon({ status }: { status: ResearchSubStatus }) {
  if (status === "done") {
    return (
      <span className="flex size-[14px] shrink-0 items-center justify-center text-success">
        <CheckIcon />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="flex size-[14px] shrink-0 items-center justify-center">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="animate-spin [animation-duration:1.6s]">
          <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.5" className="text-line" />
          <path d="M6 1.4a4.6 4.6 0 014.6 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-accent" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex size-[14px] shrink-0 items-center justify-center">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.5" className={status === "skipped" ? "text-warning-line" : "text-line"} />
      </svg>
    </span>
  );
}

/** 一行阶段：左侧固定 18px 轨道（点 + 连接线），右侧内容。 */
function Step({
  state,
  title,
  meta,
  caption,
  children,
  last = false,
}: {
  state: "done" | "active" | "pending";
  title: string;
  meta?: string;
  caption?: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  const titleCls =
    state === "active"
      ? "text-[14px] font-semibold leading-[20px] text-fg-1"
      : state === "done"
        ? "text-[13px] font-medium leading-[19px] text-fg-2"
        : "text-[13px] leading-[19px] text-fg-2/80";
  return (
    <div className="flex items-start gap-3">
      <div className="flex w-[18px] shrink-0 flex-col items-center self-stretch">
        <PhaseDot state={state} />
        {!last && <div className="min-h-[14px] w-px flex-1 bg-line" />}
      </div>
      <div className={`flex min-w-0 flex-1 flex-col gap-1 ${last ? "" : "pb-[18px]"}`}>
        <div className="flex items-baseline gap-2">
          <div className={`min-w-0 flex-1 ${titleCls}`}>{title}</div>
          {meta && <div className="shrink-0 font-mono text-[11px] leading-4 text-fg-2 tabular-nums">{meta}</div>}
        </div>
        {caption && <div className="text-[12px] leading-[17px] text-fg-3">{caption}</div>}
        {children}
      </div>
    </div>
  );
}

/**
 * 研究进度时间轴。`run.subQuestions` 存在时 gather 阶段展开子问题清单，
 * 缺失（后端未升级到契约 v2.8）时自动退回三步态 —— 不阻塞发版。
 */
export default function ResearchTimeline({
  run,
  startedAt,
}: {
  run: ResearchRun;
  startedAt?: string;
}) {
  const { t } = useI18n();
  const current = run.phase ?? "plan";
  const currentIdx = PHASES.indexOf(current);
  const elapsed = useElapsed(startedAt, true);
  // 空数组按「没有」处理：plan 阶段后端会下发 subQuestions: []（plan 列还没写），
  // 空数组是 truthy，直接用会让 gather 行既无清单也无来源计数——是空的。
  const subs = run.subQuestions?.length ? run.subQuestions : undefined;

  const stepState = (i: number): "done" | "active" | "pending" =>
    i < currentIdx ? "done" : i === currentIdx ? "active" : "pending";

  return (
    <div className="flex flex-col gap-5" data-testid="research-progress">
      <div className="flex flex-col">
        <Step
          state={stepState(0)}
          title={phaseLabel("plan", t)}
          caption={subs ? t("research.planDone", { n: subs.length }) : undefined}
        />

        <Step
          state={stepState(1)}
          title={phaseLabel("gather", t)}
          meta={stepState(1) === "active" ? (elapsed ?? undefined) : undefined}
          caption={subs ? undefined : t("research.sourcesFound", { n: run.sourcesFound })}
        >
          {subs && subs.length > 0 && (
            <ul className="mt-1 flex flex-col border-l border-field pl-3" data-testid="research-subquestions">
              {subs.map((sub, i) => (
                <li
                  key={`${i}-${sub.q}`}
                  data-testid={`research-sub-${sub.status}`}
                  className="flex items-center gap-2.5 py-1.5"
                >
                  <SubIcon status={sub.status} />
                  <span
                    className={`min-w-0 flex-1 text-[12px] leading-[18px] ${
                      sub.status === "active"
                        ? "font-medium text-fg-1"
                        : sub.status === "done"
                          ? "text-fg-2"
                          : "text-fg-3"
                    }`}
                  >
                    {sub.q}
                  </span>
                  <span className="w-[52px] shrink-0 whitespace-nowrap text-right text-[11px] leading-4">
                    {sub.status === "active" ? (
                      <span className="text-accent">{t("research.subSearching")}</span>
                    ) : sub.status === "skipped" ? (
                      <span className="text-warning">{t("research.subSkipped")}</span>
                    ) : sub.status === "done" ? (
                      <span className="font-mono text-fg-3 tabular-nums">
                        {t("research.subSources", { n: sub.sources })}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step
          state={stepState(2)}
          title={phaseLabel("synthesize", t)}
          caption={t("research.synthesizeHint")}
          last
        />
      </div>

      {run.recentSources && run.recentSources.length > 0 && (
        <div className="flex flex-col gap-2.5 border-t border-field pt-5" data-testid="research-recent-sources">
          <div className="flex items-baseline gap-2">
            <div className="caps flex-1 text-fg-3">{t("research.recentSources")}</div>
            {/* ponytail: 数字直接替换，不做滚动动画（要 rAF + 计数 hook）；
                真觉得跳变生硬再加。 */}
            <div className="font-mono text-[15px] font-medium leading-5 text-fg-1 tabular-nums">
              {run.sourcesFound}
            </div>
            <div className="text-[11px] leading-4 text-fg-3">{t("research.sourcesUnit")}</div>
          </div>
          {run.recentSources.slice(0, 3).map((src, i) => {
            const inner = (
              <>
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-line font-mono text-[9px] font-semibold uppercase text-fg-2">
                  {src.domain.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] leading-[17px] text-fg-1">
                  {src.title || src.domain}
                </span>
                <span className="w-[72px] shrink-0 truncate whitespace-nowrap text-right text-[11px] leading-4 text-fg-3">
                  {src.domain}
                </span>
              </>
            );
            const className = "bubble-in flex items-center gap-2.5 rounded-[9px] bg-surface px-2.5 py-[7px]";
            const style = { opacity: [1, 0.72, 0.45][i] ?? 0.45 };
            return isHttpUrl(src.url) ? (
              <a
                key={`${src.url}-${i}`}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
                style={style}
              >
                {inner}
              </a>
            ) : (
              <span key={`${src.url}-${i}`} className={className} style={style}>
                {inner}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
