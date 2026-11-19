import { describe, it, expect } from "vitest";
import {
  detectScript,
  quickTranslateLangs,
  isSupportedLocale,
  resolveInitialTranslateTarget,
  resolveTranslateTarget,
} from "./translate-target";

describe("overlay translate target", () => {
  it("detects the dominant script", () => {
    expect(detectScript("hello world")).toBe("latin");
    expect(detectScript("你好，世界")).toBe("cjk");
    expect(detectScript("こんにちは")).toBe("kana");
    expect(detectScript("안녕하세요")).toBe("hangul");
    expect(detectScript("12345 — !!!")).toBe("unknown");
  });

  it("uses the answer language unless the text is already in it", () => {
    // Chinese answer, English text → Chinese.
    expect(resolveTranslateTarget("zh-CN", "hello there")).toBe("zh-CN");
    // Chinese answer, Chinese text → English (translating into the source
    // language would do nothing).
    expect(resolveTranslateTarget("zh-CN", "你好世界")).toBe("en");
    expect(resolveTranslateTarget("ja", "こんにちは")).toBe("en");
    // Different script → the answer language wins.
    expect(resolveTranslateTarget("ja", "hello")).toBe("ja");
    expect(resolveTranslateTarget("en", "你好")).toBe("en");
    // Nothing to detect → plain default.
    expect(resolveTranslateTarget("pt-BR", "123")).toBe("pt-BR");
  });

  it("prefers the remembered pick, but only when it is a real locale", () => {
    expect(resolveInitialTranslateTarget("ja", "zh-CN", "hello")).toBe("ja");
    expect(resolveInitialTranslateTarget("de", "zh-CN", "hello")).toBe("de");
    expect(resolveInitialTranslateTarget("xx", "zh-CN", "hello")).toBe("zh-CN");
    expect(resolveInitialTranslateTarget(undefined, "zh-CN", "你好")).toBe("en");
    expect(isSupportedLocale("zh-TW")).toBe(true);
    expect(isSupportedLocale("de")).toBe(false);
  });

  it("offers quick languages without the source language", () => {
    expect(quickTranslateLangs("en", "我的账单明细")).toEqual(["en", "ja", "ko"]);
    expect(quickTranslateLangs("ja", "hello")).toEqual(["ja", "zh-CN", "ko"]);
    // The current pick is kept even when it matches the source script.
    expect(quickTranslateLangs("zh-TW", "你好")).toEqual(["zh-TW", "en", "ja"]);
  });
});
