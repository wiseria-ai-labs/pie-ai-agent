import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";
import { AgentSelect } from "./hitl/AgentSelect";
import type { HandoffBrandOption } from "@/lib/agent/tools/handoff";

interface Props {
  payload: { context: string; fileCount: number; brands: HandoffBrandOption[] };
  onDecision: (target: string | null) => void;
}

function defaultFormId(forms: HandoffBrandOption["forms"]): string {
  return forms.find((f) => f.kind === "app")?.id ?? forms[0]?.id ?? "";
}

const HandoffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    <path d="m15 4 5 5-5 5" />
  </svg>
);

/**
 * 交棒授权卡（#270 迁 HitlCardShell，warning 档）：用户在此选收件人（LLM 不能选
 * ——收件人选择与授权是同一步）。context 原文渲染，让用户看到将写入 context.md
 * 的内容。与 run_local_agent 卡的语义区分：任务移交出去，结果不回来。
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  const first = payload.brands[0];
  const [brandId, setBrandId] = useState(first?.id ?? "");
  const [formId, setFormId] = useState(defaultFormId(first?.forms ?? []));
  const brand = payload.brands.find((b) => b.id === brandId) ?? first;
  const selectedForm = brand?.forms.find((f) => f.id === formId) ?? brand?.forms[0];
  const showFormSegment = (brand?.forms.length ?? 0) === 2;
  const formNote =
    selectedForm?.kind === "terminal" ? t("handoff.form.noteTerminal") : t("handoff.form.noteApp");

  const onBrand = (id: string) => {
    setBrandId(id);
    const next = payload.brands.find((b) => b.id === id);
    setFormId(defaultFormId(next?.forms ?? []));
  };

  return (
    <HitlCardShell
      register="local"
      icon={<HandoffIcon />}
      capsLabel={t("hitl.caps.handoff")}
      title={t("handoff.title")}
      description={t("handoff.semanticsNote")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(null)}>
            {t("handoff.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(formId)}>
            {t("handoff.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <AgentSelect
            label={t("handoff.targetLabel")}
            agents={payload.brands.map((b) => ({ id: b.id, label: b.label }))}
            selected={brandId}
            onSelect={onBrand}
          />
        </div>
        {showFormSegment && brand && (
          <div
            className="flex h-[38px] w-1/3 max-w-[33%] shrink-0 gap-0.5 rounded-lg border border-line bg-field p-0.5"
            role="group"
            aria-label={t("handoff.form.groupLabel")}
          >
            {brand.forms.map((f) => {
              const pressed = f.id === formId;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setFormId(f.id)}
                  className={`min-w-0 flex-1 truncate rounded-md px-1.5 text-[12px] ${
                    pressed ? "bg-canvas font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"
                  }`}
                >
                  {f.kind === "app" ? t("handoff.form.app") : t("handoff.form.terminal")}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-[12px] leading-relaxed text-fg-3">{formNote}</p>
      <HitlDetailBlock>
        <HitlDetailGroup label={t("handoff.contextLabel")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-fg-2">
            {payload.context}
          </pre>
        </HitlDetailGroup>
        {payload.fileCount > 0 && (
          <span className="text-[11px] text-fg-3">
            {t("handoff.filesLabel")}: {payload.fileCount}
          </span>
        )}
      </HitlDetailBlock>
    </HitlCardShell>
  );
}
