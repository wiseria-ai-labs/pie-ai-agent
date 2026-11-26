import { describe, it, expect } from "vitest";
import {
  shouldOpenChangelog,
  shouldOpenUpdateTab,
  buildChangelogUrl,
  buildPostUpdateUrl,
  websiteLocalePath,
} from "./update-changelog";
import {
  HOLIDAY_SALE_START_UTC,
  HOLIDAY_SALE_END_UTC,
} from "./holiday-sale";

describe("shouldOpenChangelog", () => {
  it("opens on a minor bump", () => {
    expect(shouldOpenChangelog("1.2.2", "1.3.0")).toBe(true);
  });

  it("opens on a major bump", () => {
    expect(shouldOpenChangelog("1.9.9", "2.0.0")).toBe(true);
  });

  it("opens on a major bump even when minor decreases", () => {
    expect(shouldOpenChangelog("1.5.0", "2.0.0")).toBe(true);
  });

  it("stays silent on a patch-only bump", () => {
    expect(shouldOpenChangelog("1.2.2", "1.2.3")).toBe(false);
  });

  it("stays silent on identical versions", () => {
    expect(shouldOpenChangelog("1.2.2", "1.2.2")).toBe(false);
  });

  it("stays silent on a downgrade", () => {
    expect(shouldOpenChangelog("1.3.0", "1.2.0")).toBe(false);
  });

  it("stays silent on a major downgrade", () => {
    expect(shouldOpenChangelog("2.0.0", "1.9.0")).toBe(false);
  });

  it("stays silent when previousVersion is undefined (fresh install-like)", () => {
    expect(shouldOpenChangelog(undefined, "1.3.0")).toBe(false);
  });

  it("stays silent when previousVersion is an unparseable string", () => {
    expect(shouldOpenChangelog("not-a-version", "1.3.0")).toBe(false);
  });

  it("stays silent when previousVersion is empty", () => {
    expect(shouldOpenChangelog("", "1.3.0")).toBe(false);
  });

  it("stays silent when the current version is unparseable", () => {
    expect(shouldOpenChangelog("1.2.2", "garbage")).toBe(false);
  });

  it("tolerates two-part versions (major.minor)", () => {
    expect(shouldOpenChangelog("1.2", "1.3")).toBe(true);
    expect(shouldOpenChangelog("1.3", "1.3")).toBe(false);
  });

  it("treats a partial numeric like a version with trailing junk as unparseable", () => {
    expect(shouldOpenChangelog("1.2.x", "1.3.0")).toBe(false);
  });
});

describe("websiteLocalePath", () => {
  it("maps English to the root (empty) path", () => {
    expect(websiteLocalePath("en")).toBe("");
  });

  it("maps zh-CN to the zh-Hans directory", () => {
    expect(websiteLocalePath("zh-CN")).toBe("zh-Hans/");
  });

  it("maps zh-TW to the zh-Hant directory", () => {
    expect(websiteLocalePath("zh-TW")).toBe("zh-Hant/");
  });

  it("maps the remaining locales to same-named directories", () => {
    expect(websiteLocalePath("es-419")).toBe("es-419/");
    expect(websiteLocalePath("ja")).toBe("ja/");
    expect(websiteLocalePath("pt-BR")).toBe("pt-BR/");
  });
});

describe("buildChangelogUrl", () => {
  it("builds an English (root) changelog URL with from/to params", () => {
    expect(buildChangelogUrl("en", "1.2.2", "1.3.0")).toBe(
      "https://www.pie.chat/changelog?from=1.2.2&to=1.3.0",
    );
  });

  it("routes 2.0.0 upgrades to the dedicated /v2 showcase page", () => {
    expect(buildChangelogUrl("en", "1.5.1", "2.0.0")).toBe(
      "https://www.pie.chat/v2",
    );
    expect(buildChangelogUrl("zh-CN", "1.5.1", "2.0.0")).toBe(
      "https://www.pie.chat/zh-Hans/v2",
    );
    expect(buildChangelogUrl("ja", "1.9.9", "2.0.1")).toBe(
      "https://www.pie.chat/ja/v2",
    );
  });

  it("keeps the localized changelog URL for later 2.1+ upgrades", () => {
    expect(buildChangelogUrl("zh-CN", "2.0.0", "2.1.0")).toBe(
      "https://www.pie.chat/zh-Hans/changelog?from=2.0.0&to=2.1.0",
    );
  });
});

describe("shouldOpenUpdateTab & buildPostUpdateUrl (Holiday Sale 2026)", () => {
  const insideWindow = HOLIDAY_SALE_START_UTC + 3600_000;
  const beforeWindow = HOLIDAY_SALE_START_UTC - 1;
  const atWindowEnd = HOLIDAY_SALE_END_UTC;

  it("during holiday window: opens localized /holiday on patch, minor, and major upgrades", () => {
    expect(shouldOpenUpdateTab("2.0.0", "2.0.1", insideWindow)).toBe(true);
    expect(buildPostUpdateUrl("en", "2.0.0", "2.0.1", insideWindow)).toBe(
      "https://www.pie.chat/holiday",
    );
    expect(buildPostUpdateUrl("zh-CN", "1.5.2", "2.0.1", insideWindow)).toBe(
      "https://www.pie.chat/zh-Hans/holiday",
    );
    expect(buildPostUpdateUrl("zh-TW", "2.0.0", "2.1.0", insideWindow)).toBe(
      "https://www.pie.chat/zh-Hant/holiday",
    );
    expect(buildPostUpdateUrl("ja", "2.0.1", "2.0.2", HOLIDAY_SALE_END_UTC - 1)).toBe(
      "https://www.pie.chat/ja/holiday",
    );
  });

  it("during holiday window: stays silent on downgrades, equal versions, or invalid previousVersion", () => {
    expect(shouldOpenUpdateTab("2.0.1", "2.0.0", insideWindow)).toBe(false);
    expect(buildPostUpdateUrl("en", "2.0.1", "2.0.0", insideWindow)).toBeNull();
    expect(buildPostUpdateUrl("en", "2.0.1", "2.0.1", insideWindow)).toBeNull();
    expect(buildPostUpdateUrl("en", "2.0", "2.0.0", insideWindow)).toBeNull();
    expect(buildPostUpdateUrl("en", undefined, "2.0.1", insideWindow)).toBeNull();
    expect(buildPostUpdateUrl("en", "bad", "2.0.1", insideWindow)).toBeNull();
  });

  it("outside holiday window: falls back strictly to minor/major changelog rules", () => {
    expect(shouldOpenUpdateTab("2.0.0", "2.0.1", beforeWindow)).toBe(false);
    expect(buildPostUpdateUrl("en", "2.0.0", "2.0.1", beforeWindow)).toBeNull();
    expect(shouldOpenUpdateTab("2.0.0", "2.0.1", atWindowEnd)).toBe(false);
    expect(buildPostUpdateUrl("en", "2.0.0", "2.0.1", atWindowEnd)).toBeNull();

    expect(buildPostUpdateUrl("en", "1.5.1", "2.0.0", beforeWindow)).toBe(
      "https://www.pie.chat/v2",
    );
    expect(buildPostUpdateUrl("zh-CN", "2.0.0", "2.1.0", atWindowEnd)).toBe(
      "https://www.pie.chat/zh-Hans/changelog?from=2.0.0&to=2.1.0",
    );
  });
});
