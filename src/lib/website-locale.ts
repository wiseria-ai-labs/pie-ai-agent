import type { Locale } from "@/lib/i18n/types";

// Extension UI locale → website locale directory. The website hosts localized
// pages under a per-locale directory (root = English). Simplified/Traditional
// Chinese UI locales map onto the website's script-based `zh-Hans` / `zh-Hant`
// directory names; the rest share the same tag. Declared as a full Record so
// adding a new UI Locale is a compile error here until mapped.
const WEBSITE_LOCALE_PATH: Record<Locale, string> = {
  en: "",
  "zh-CN": "zh-Hans/",
  "zh-TW": "zh-Hant/",
  "es-419": "es-419/",
  ja: "ja/",
  "pt-BR": "pt-BR/",
};

/**
 * Map an extension UI locale to the website locale path segment
 * (with trailing slash, or "" for the English root).
 */
export function websiteLocalePath(locale: Locale): string {
  return WEBSITE_LOCALE_PATH[locale];
}
