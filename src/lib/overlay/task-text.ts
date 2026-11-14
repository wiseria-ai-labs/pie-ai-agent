// English, model-facing instructions for the structured overlay tasks
// (explain / translate / rewrite). The overlay sends `{kind, …}`; this module
// owns what the model actually reads, so no localized template ever ends up in
// the conversation as the user's message.

import { LANGUAGE_LABELS } from "@/lib/i18n/language-labels";
import type { Locale } from "@/lib/i18n/locales";
import type { OverlayTask } from "./protocol";
import { isTranslateLang, translateLangName } from "./translate-target";

const STYLE_INSTRUCTIONS = {
  formal:
    "Rewrite the selected text in a more formal, professional tone. Keep the language of the original.",
  concise: "Rewrite the selected text more concisely without losing meaning. Keep the language of the original.",
  casual: "Rewrite the selected text in a casual, conversational tone. Keep the language of the original.",
  proofread:
    "Fix spelling, grammar and punctuation in the selected text. Keep the original tone and language.",
  expand: "Expand the selected text with a little more detail. Keep the language of the original.",
} as const;

/**
 * The instruction that rides in the wire content before the page quote.
 *
 * `answerLang` is the user's answer-language setting; it only matters for
 * `explain` (translate states its own target; rewrite must keep the original
 * language).
 */
export function buildOverlayTaskInstruction(
  task: OverlayTask,
  answerLang: Locale,
  editable = false,
): string {
  // Editable selection: the result goes through propose_rewrite so the user
  // gets a Replace button (the tool is only offered on such runs).
  const out = editable
    ? "The selection is editable on the page: pass the result to propose_rewrite (text only) and keep your reply to one short line."
    : null;
  switch (task.kind) {
    case "explain":      return `The user selected text on a web page. Explain what it means, including any context that helps them understand it. Answer in ${LANGUAGE_LABELS[answerLang]}.`;
    case "translate": {
      // The code lands in the trusted task text: only known codes pass.
      const lang = isTranslateLang(task.targetLang) ? task.targetLang : "en";
      const label = LANGUAGE_LABELS[lang as Locale] ?? `${translateLangName(lang, "en")} (${lang})`;
      return `Translate the selected text into ${label}. Preserve the original formatting, names, numbers and code. ${out ?? "Output only the translation."}`;
    }
    case "rewrite": {
      const style = task.style ? STYLE_INSTRUCTIONS[task.style] : null;
      const custom = task.custom?.trim();
      if (style && !custom) {
        return `${style} ${out ?? "Output only the rewritten text."}`;
      }
      if (custom) {
        return `Rewrite the selected text according to this instruction: "${custom}". Keep the language of the original. ${out ?? "Output only the rewritten text."}`;
      }
      return `${STYLE_INSTRUCTIONS.formal} ${out ?? "Output only the rewritten text."}`;
    }
  }
}
