import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Chrome Web Store form limits. Overflowing either one is only discovered at
// upload time, long after the copy was written — so assert them here instead.
const NAME_LIMIT = 75;
const DESCRIPTION_LIMIT = 132;

const LOCALES = ["en", "es_419", "ja", "pt_BR", "zh_CN", "zh_TW"] as const;

type Messages = Record<string, { message: string; description?: string }>;

function messages(locale: string): Messages {
  const path = resolve(process.cwd(), "_locales", locale, "messages.json");
  return JSON.parse(readFileSync(path, "utf8")) as Messages;
}

describe("store copy", () => {
  it.each(LOCALES)("%s fits the store form limits", (locale) => {
    const m = messages(locale);
    expect(m.extension_name.message.length).toBeLessThanOrEqual(NAME_LIMIT);
    expect(m.extension_description.message.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    // The Edge substitute ships through the same form; make-edge-package.mjs
    // checks it only after a build, which never runs on a docs-only change.
    expect(m.extension_description_edge.message.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(m.extension_description_edge.message).not.toMatch(/chrome/i);
  });

  it("keeps the same keys in every locale", () => {
    const en = Object.keys(messages("en")).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages(locale)).sort(), locale).toEqual(en);
    }
  });
});
