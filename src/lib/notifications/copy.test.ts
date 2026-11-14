// Parity + behavior of the SW-side notification copy table.
//
// The panel dictionaries are parity-tested against English; this smaller table
// needs the same guarantee, otherwise a locale silently renders `key` text in a
// system notification.

import { describe, it, expect } from "vitest";
import { NOTIFY_TABLES, EN_NOTIFY_TABLE, notifT } from "./copy";
import { SUPPORTED_LOCALES } from "@/lib/i18n/locales";

describe("SW notification copy", () => {
  it("every supported locale has exactly the English key set", () => {
    const enKeys = Object.keys(EN_NOTIFY_TABLE).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(NOTIFY_TABLES[locale]).sort(), locale).toEqual(enKeys);
    }
  });

  it("every value is a non-empty string", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [k, v] of Object.entries(NOTIFY_TABLES[locale])) {
        expect(typeof v, `${locale}:${k}`).toBe("string");
        expect(v.length, `${locale}:${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the same {placeholders} per key across locales", () => {
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(EN_NOTIFY_TABLE) as Array<keyof typeof EN_NOTIFY_TABLE>) {
      const en = placeholders(EN_NOTIFY_TABLE[key]);
      for (const locale of SUPPORTED_LOCALES) {
        expect(placeholders(NOTIFY_TABLES[locale][key]), `${locale}:${key}`).toEqual(en);
      }
    }
  });

  it("localizes the monitor notification surface (zh-CN sample)", () => {
    expect(NOTIFY_TABLES["zh-CN"]["monitor.button.openPage"]).toBe("打开页面");
    expect(NOTIFY_TABLES["zh-CN"]["monitor.button.stop"]).toBe("停止监控");
    expect(NOTIFY_TABLES["zh-CN"]["monitor.highlight.label"]).toContain("盯住");
    expect(NOTIFY_TABLES["zh-CN"]["monitor.reason.login"]).toBe("需要登录");
  });

  it("falls back to English when no chrome runtime is available", async () => {
    // The test environment has no chrome.i18n → resolveLocale throws → EN.
    expect(await notifT("monitor.button.openPage")).toBe("Open page");
    expect(await notifT("monitor.paused.body", { count: 3, reason: "login" })).toBe(
      "Paused after 3 failed checks (login).",
    );
  });
});
