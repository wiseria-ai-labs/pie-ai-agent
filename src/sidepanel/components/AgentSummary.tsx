import { useT } from "@/lib/i18n";
import MarkdownContent from "./Markdown";
import VailieMark from "./VailieMark";

interface AgentSummaryProps {
  success: boolean;
  summary: string;
  stepCount: number;
}

export default function AgentSummary({
  success,
  summary,
  stepCount,
}: AgentSummaryProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2.5 pt-2">
      <div className="flex items-center gap-2">
        {/* F7 (H 屏最小落地) — static done mesh marks the turn as concluded.
            animate={false}: a one-shot bloom-on-completion animation is a
            separate, deferred piece of work (would otherwise replay every
            time an old turn scrolls back into view / history re-renders). */}
        <VailieMark size={18} state="done" animate={false} />
        <div
          className={`h-1 w-1 rounded-full ${
            success ? "bg-accent" : "bg-warning"
          }`}
        />
        <span
          className={`caps ${success ? "text-fg-2" : "text-warning"}`}
        >
          {success
            ? t("agentSummary.doneSteps", { count: stepCount })
            : t("agentSummary.failedAtStep", { step: stepCount })}
        </span>
      </div>
      <div className="text-[13px] leading-5 text-fg-1">
        <MarkdownContent content={summary} />
      </div>
    </div>
  );
}
