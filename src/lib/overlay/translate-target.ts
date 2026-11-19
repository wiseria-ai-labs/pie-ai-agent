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

/** Translate targets: the UI locales plus the other big languages people
 *  read. Order = the "more" grid order. */
export const TRANSLATE_LANGS = [
  "en", "zh-CN", "zh-TW", "ja", "ko", "fr", "de", "es-419", "pt-BR", "ru",
] as const;
export type TranslateLang = (typeof TRANSLATE_LANGS)[number];

export function isTranslateLang(value: unknown): value is TranslateLang {
  return typeof value === "string" && (TRANSLATE_LANGS as readonly string[]).includes(value);
}

function scriptForLang(lang: string): TextScript {
  switch (lang) {
    case "zh-CN":
    case "zh-TW":
      return "cjk";
    case "ja":
      return "kana";
    case "ko":
      return "hangul";
    case "ru":
      return "cyrillic";
    default:
      return "latin";
  }
}

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

const NAME_TAG: Record<string, string> = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", "es-419": "es", "pt-BR": "pt" };

/** Language name in `displayLocale` (Intl owns the translations); falls back
 *  to the code on runtimes without Intl.DisplayNames. */
export function translateLangName(code: string, displayLocale: string): string {
  try {
    // Script / bare-language tags read better than region names here
    // ("简体中文", not "中文（中国）"; "西班牙语", not "拉丁美洲西班牙语").
    const tag = NAME_TAG[code] ?? code;
    return new Intl.DisplayNames([displayLocale], { type: "language" }).of(tag) ?? code;
  } catch {
    return code;
  }
}

/**
 * The few languages offered as one-click buttons: the current target first,
 * then the usual picks, minus the language the text is already written in.
 * Script-level only (Latin languages are not told apart).
 */
export function quickTranslateLangs(current: string, selectionText: string, max = 3): string[] {
  const script = detectScript(selectionText);
  const out: string[] = [];
  for (const lang of [current, "en", "zh-CN", "ja", "ko"]) {
    if (out.includes(lang)) continue;
    if (lang !== current && script !== "unknown" && scriptForLang(lang) === script) continue;
    out.push(lang);
    if (out.length === max) break;
  }
  return out;
}

/** Answer language, with the "already that language → English" rule applied. */
export function resolveTranslateTarget(answerLang: Locale, selectionText: string): Locale {
  const script = detectScript(selectionText);
  if (script === "unknown") return answerLang;
  // Translating into the language the text is already in is a no-op.
  return scriptForLang(answerLang) === script ? "en" : answerLang;
}

/**
 * The chip's initial value: the user's last explicit pick wins, otherwise the
 * answer-language default (with the no-op rule).
 */
export function resolveInitialTranslateTarget(
  lastChoice: string | undefined,
  answerLang: Locale,
  selectionText: string,
): string {
  if (isTranslateLang(lastChoice)) return lastChoice;
  return resolveTranslateTarget(answerLang, selectionText);
}
