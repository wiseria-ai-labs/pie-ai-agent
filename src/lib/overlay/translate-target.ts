// Translate chip: which language is the default, and is the selection already
// in it? (User-reported gap: "翻译成什么语言没定义".)
//
// Default = the user's answer language. If the selection is already written in
// that language, translating into it would be a no-op, so English is used
// instead. Script-level detection only: telling Spanish from Portuguese would
// need a model, and for that side of the rule the "already same language"
// fallback is English anyway.

import { SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/locales";

export type TextScript = "kana" | "hangul" | "cjk" | "cyrillic" | "arabic" | "latin" | "unknown";

const RANGES: Array<[TextScript, RegExp]> = [
  ["kana", /[぀-ヿ]/g],
  ["hangul", /[가-힯]/g],
  ["cjk", /[㐀-鿿豈-﫿]/g],
  ["cyrillic", /[Ѐ-ӿ]/g],
  ["arabic", /[؀-ۿ]/g],
  ["latin", /[a-zÀ-ɏ]/gi],
];

/** Dominant script of a text (count-based; ties go to the earlier range). */
export function detectScript(text: string): TextScript {
  let best: TextScript = "unknown";
  let bestCount = 0;
  for (const [script, re] of RANGES) {
    const count = (text.match(re) ?? []).length;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

function scriptForLocale(locale: Locale): TextScript {
  switch (locale) {
    case "zh-CN":
    case "zh-TW":
      return "cjk";
    case "ja":
      return "kana";
    default:
      return "latin";
  }
}

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Answer language, with the "already that language → English" rule applied. */
export function resolveTranslateTarget(answerLang: Locale, selectionText: string): Locale {
  const script = detectScript(selectionText);
  if (script === "unknown") return answerLang;
  // Translating into the language the text is already in is a no-op.
  return scriptForLocale(answerLang) === script ? "en" : answerLang;
}

/**
 * The chip's initial value: the user's last explicit pick wins, otherwise the
 * answer-language default (with the no-op rule).
 */
export function resolveInitialTranslateTarget(
  lastChoice: string | undefined,
  answerLang: Locale,
  selectionText: string,
): Locale {
  if (isSupportedLocale(lastChoice)) return lastChoice;
  return resolveTranslateTarget(answerLang, selectionText);
}
