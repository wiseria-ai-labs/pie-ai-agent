import { describe, it, expect } from "vitest";
import {
  DEFAULT_OVERLAY_SETTINGS,
  normalizeOverlaySettings,
  shouldShowSelectionBar,
} from "./settings";
import { isWithinRetention } from "./tab-session";
import { buildOverlayWireContent } from "./wire";
import { overlayPanelDeeplink, parseOverlayPanelDeeplink, overlayPrefillDeeplink, parseOverlayPrefillDeeplink } from "@/lib/deeplink";

describe("overlay settings", () => {
  it("normalizes junk into a usable record", () => {
    expect(normalizeOverlaySettings(undefined)).toEqual(DEFAULT_OVERLAY_SETTINGS);
    expect(normalizeOverlaySettings({ retentionMinutes: 77, position: "left" })).toMatchObject({
      retentionMinutes: 30,
      position: "anchor",
      barEnabled: true,
    });
    expect(
      normalizeOverlaySettings({ barEnabled: false, excludedHosts: ["a.com", 3], retentionMinutes: 10 }),
    ).toEqual({ barEnabled: false, excludedHosts: ["a.com"], position: "anchor", retentionMinutes: 10 });
  });

  it("hides the bar when disabled or on an excluded host", () => {
    const s = { barEnabled: true, excludedHosts: ["news.example"] };
    expect(shouldShowSelectionBar(s, "other.example")).toBe(true);
    expect(shouldShowSelectionBar(s, "news.example")).toBe(false);
    expect(shouldShowSelectionBar({ ...s, barEnabled: false }, "other.example")).toBe(false);
  });
});

describe("overlay retention window", () => {
  const now = 1_000_000_000;

  it("accepts a tab session inside the window", () => {
    expect(isWithinRetention(now - 29 * 60_000, 30, now)).toBe(true);
  });

  it("rejects one past the window", () => {
    expect(isWithinRetention(now - 31 * 60_000, 30, now)).toBe(false);
  });

  it("rejects clock skew from the future and garbage timestamps", () => {
    expect(isWithinRetention(now + 60_000, 30, now)).toBe(false);
    expect(isWithinRetention(Number.NaN, 30, now)).toBe(false);
  });
});

describe("overlay wire content", () => {
  it("wraps the selection as untrusted data and keeps the instruction outside", () => {
    const wire = buildOverlayWireContent("改得客气一点", {
      text: "必须交",
      editable: true,
      url: "https://mail.example.com/x?a=1&b=2",
    });
    expect(wire).toContain('<untrusted_page_selection source_url="https://mail.example.com/x?a=1&amp;b=2" editable="true">');
    expect(wire).toContain("必须交");
    expect(wire.trim().endsWith("改得客气一点")).toBe(true);
  });

  it("passes the instruction through untouched without a selection", () => {
    expect(buildOverlayWireContent("你好", null)).toBe("你好");
  });

  it("escapes quotes/angle brackets in the url attribute", () => {
    const wire = buildOverlayWireContent("x", { text: "t", editable: false, url: 'https://a/"onmouseover="x' });
    expect(wire).not.toContain('"onmouseover="');
    expect(wire).toContain("&quot;onmouseover=&quot;");
  });
});

describe("overlay deeplinks", () => {
  it("round-trips the panel session id", () => {
    expect(parseOverlayPanelDeeplink(overlayPanelDeeplink("abc"))).toBe("abc");
  });

  it("round-trips an omnibox prefill (including colons)", () => {
    const text = "总结 https://example.com:8080/x";
    expect(parseOverlayPrefillDeeplink(overlayPrefillDeeplink(text))).toBe(text);
  });

  it("ignores unrelated values", () => {
    expect(parseOverlayPanelDeeplink("managed-subscribe")).toBeNull();
    expect(parseOverlayPrefillDeeplink(undefined)).toBeNull();
  });
});
