import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  brandIdFromFormId,
  brandLabelFromFormLabel,
  inferFormKind,
  normalizeEnabledBrands,
  isAgentUsable,
  filterUsableAgents,
  filterHandoffAgents,
  filterHeadlessBackends,
  applyToggle,
  groupAgentsByBrand,
  getEnabledLocalAgents,
  setEnabledLocalAgents,
} from "./local-agents-prefs";

const DETECTED = [
  { id: "claude-app", label: "Claude Code (App)", installed: true },
  { id: "claude-terminal", label: "Claude Code (Terminal)", installed: false },
  { id: "codex-terminal", label: "Codex (Terminal)", installed: true },
];

describe("brand identity helpers", () => {
  it("strips the form suffix to get the brand id", () => {
    expect(brandIdFromFormId("claude-app")).toBe("claude");
    expect(brandIdFromFormId("claude-terminal")).toBe("claude");
    expect(brandIdFromFormId("codex-app")).toBe("codex");
    expect(brandIdFromFormId("opencode-terminal")).toBe("opencode");
    expect(brandIdFromFormId("pi-terminal")).toBe("pi");
    expect(brandIdFromFormId("dsh-app")).toBe("dsh");
    expect(brandIdFromFormId("dsh-terminal")).toBe("dsh");
    expect(brandIdFromFormId("claude")).toBe("claude");
  });

  it("strips (App)/(Terminal) from form labels", () => {
    expect(brandLabelFromFormLabel("Claude Code (App)")).toBe("Claude Code");
    expect(brandLabelFromFormLabel("Codex / ChatGPT (App)")).toBe("Codex / ChatGPT");
    expect(brandLabelFromFormLabel("Pi (Terminal)")).toBe("Pi");
    expect(brandLabelFromFormLabel("Pi")).toBe("Pi");
  });

  it("infers form kind from id when daemon omits kind", () => {
    expect(inferFormKind("claude-app")).toBe("app");
    expect(inferFormKind("claude-terminal")).toBe("terminal");
    expect(inferFormKind("claude-app", "app")).toBe("app");
    expect(inferFormKind("claude")).toBe("terminal");
    expect(inferFormKind("mystery")).toBeUndefined();
  });
});

describe("normalizeEnabledBrands (legacy form-id prefs ∪ brand ids)", () => {
  it("null stays null (installed-means-enabled)", () => {
    expect(normalizeEnabledBrands(null)).toBe(null);
  });
  it("unions old form ids onto the brand", () => {
    expect(normalizeEnabledBrands(["claude-app"])).toEqual(["claude"]);
    expect(normalizeEnabledBrands(["claude-terminal"])).toEqual(["claude"]);
    expect(normalizeEnabledBrands(["claude-app", "claude-terminal"])).toEqual(["claude"]);
  });
  it("keeps already-brand ids and dedupes mixed arrays", () => {
    expect(normalizeEnabledBrands(["claude", "codex-terminal", "claude-app"])).toEqual(["claude", "codex"]);
  });
});

describe("isAgentUsable (shared predicate: settings enabled 标注与 handoff 过滤的唯一真源)", () => {
  it("installed + null prefs → usable; not installed → never usable", () => {
    expect(isAgentUsable(DETECTED[0], null)).toBe(true);
    expect(isAgentUsable(DETECTED[1], null)).toBe(false);
    expect(isAgentUsable(DETECTED[1], ["claude"])).toBe(false);
    expect(isAgentUsable(DETECTED[1], ["claude-terminal"])).toBe(false);
  });
  it("explicit brand prefs gate installed forms of that brand", () => {
    expect(isAgentUsable(DETECTED[0], ["codex"])).toBe(false);
    expect(isAgentUsable(DETECTED[2], ["codex"])).toBe(true);
  });
  it("legacy form-id prefs union to the brand: claude-app enables the installed Claude form", () => {
    expect(isAgentUsable(DETECTED[0], ["claude-app"])).toBe(true);
    expect(isAgentUsable(DETECTED[0], ["claude-terminal"])).toBe(true);
    expect(isAgentUsable(DETECTED[2], ["claude-app"])).toBe(false);
  });
  it("a brand with only one form installed is still usable under that brand pref", () => {
    expect(isAgentUsable(DETECTED[0], ["claude"])).toBe(true);
    expect(isAgentUsable(DETECTED[1], ["claude"])).toBe(false);
  });
});

describe("filterUsableAgents", () => {
  it("null prefs = every installed agent usable (out-of-box default)", () => {
    expect(filterUsableAgents(DETECTED, null).map((a) => a.id)).toEqual(["claude-app", "codex-terminal"]);
  });
  it("explicit brand prefs intersect with installed forms", () => {
    expect(filterUsableAgents(DETECTED, ["codex"]).map((a) => a.id)).toEqual(["codex-terminal"]);
  });
  it("legacy form-id prefs union to the brand", () => {
    expect(filterUsableAgents(DETECTED, ["claude-app"]).map((a) => a.id)).toEqual(["claude-app"]);
    expect(filterUsableAgents(DETECTED, ["claude-terminal"]).map((a) => a.id)).toEqual(["claude-app"]);
  });
  it("not-installed never usable even if the brand is listed", () => {
    const onlyUninstalled = [
      { id: "claude-app", label: "Claude Code (App)", installed: false },
      { id: "claude-terminal", label: "Claude Code (Terminal)", installed: false },
    ];
    expect(filterUsableAgents(onlyUninstalled, ["claude"])).toEqual([]);
    expect(filterUsableAgents(DETECTED, ["claude-terminal"]).map((a) => a.id)).toEqual(["claude-app"]);
  });
});

describe("filterHeadlessBackends (run_local_agent 卡片后端预筛)", () => {
  const HEADLESS_DETECTED = [
    { id: "claude-app", label: "Claude Code (App)", installed: true, kind: "app" as const, headless: false },
    { id: "claude-terminal", label: "Claude Code (Terminal)", installed: true, kind: "terminal" as const, headless: true },
    { id: "codex-terminal", label: "Codex (Terminal)", installed: false, kind: "terminal" as const, headless: true },
  ];

  it("keeps only installed ∩ enabled ∩ headless (app forms excluded)", () => {
    expect(filterHeadlessBackends(HEADLESS_DETECTED, null).map((a) => a.id)).toEqual(["claude-terminal"]);
  });

  it("legacy form-id prefs union to the brand (claude-app enables claude-terminal)", () => {
    expect(filterHeadlessBackends(HEADLESS_DETECTED, ["claude-app"]).map((a) => a.id)).toEqual([
      "claude-terminal",
    ]);
  });

  it("brand prefs gate headless backends", () => {
    expect(filterHeadlessBackends(HEADLESS_DETECTED, ["codex"])).toEqual([]);
    expect(filterHeadlessBackends(HEADLESS_DETECTED, ["claude"]).map((a) => a.id)).toEqual(["claude-terminal"]);
  });

  it("falls back to kind === terminal when daemon omits headless flag (old daemon)", () => {
    const oldDaemon = [
      { id: "claude-app", label: "Claude Code (App)", installed: true, kind: "app" as const },
      { id: "pi-terminal", label: "Pi (Terminal)", installed: true, kind: "terminal" as const },
    ];
    expect(filterHeadlessBackends(oldDaemon, null).map((a) => a.id)).toEqual(["pi-terminal"]);
  });

  it("includes dsh-terminal as a headless backend", () => {
    const detected = [
      { id: "dsh-app", label: "DeepSeek Harness (App)", installed: true, kind: "app" as const, headless: false },
      { id: "dsh-terminal", label: "DeepSeek Harness (Terminal)", installed: true, kind: "terminal" as const, headless: true },
    ];
    expect(filterHeadlessBackends(detected, null).map((a) => a.id)).toEqual(["dsh-terminal"]);
  });
});

describe("filterHandoffAgents (交棒卡：排除仅 headless)", () => {
  const DSH = [
    {
      id: "dsh-app",
      label: "DeepSeek Harness (App)",
      installed: true,
      kind: "app" as const,
      interactive: true,
    },
    {
      id: "dsh-terminal",
      label: "DeepSeek Harness (Terminal)",
      installed: true,
      kind: "terminal" as const,
      interactive: false,
    },
    {
      id: "claude-terminal",
      label: "Claude Code (Terminal)",
      installed: true,
      kind: "terminal" as const,
      interactive: true,
    },
  ];

  it("keeps the DSH app form and other interactive terminals; drops headless-only dsh-terminal", () => {
    expect(filterHandoffAgents(DSH, null).map((a) => a.id)).toEqual(["dsh-app", "claude-terminal"]);
  });

  it("old daemon omitting interactive still lists installed terminals (not headless-only)", () => {
    const oldDaemon = [
      { id: "claude-app", installed: true, kind: "app" as const },
      { id: "claude-terminal", installed: true, kind: "terminal" as const },
    ];
    expect(filterHandoffAgents(oldDaemon, null).map((a) => a.id)).toEqual([
      "claude-app",
      "claude-terminal",
    ]);
  });
});

describe("applyToggle (brand id)", () => {
  it("enabling a brand with no installed form is rejected", () => {
    expect(applyToggle(DETECTED, null, "cursor", true)).toEqual({ ok: false, reason: "not_installed" });
  });
  it("enabling a brand that only has an uninstalled form is rejected", () => {
    const none = DETECTED.map((a) => ({ ...a, installed: false }));
    expect(applyToggle(none, null, "claude", true)).toEqual({ ok: false, reason: "not_installed" });
  });
  it("a brand with only one form installed can still be enabled", () => {
    expect(applyToggle(DETECTED, ["codex"], "claude", true)).toEqual({ ok: true, next: ["codex", "claude"] });
  });
  it("first toggle materializes null prefs as all-installed brands, then applies", () => {
    expect(applyToggle(DETECTED, null, "codex", false)).toEqual({ ok: true, next: ["claude"] });
  });
  it("re-enabling adds a brand id without duplicates; normalizes leftover form ids", () => {
    expect(applyToggle(DETECTED, ["claude-app"], "codex", true)).toEqual({
      ok: true,
      next: ["claude", "codex"],
    });
  });
  it("disabling a brand is allowed regardless of installed state", () => {
    expect(applyToggle(DETECTED, ["claude", "codex"], "claude", false)).toEqual({
      ok: true,
      next: ["codex"],
    });
  });
});

describe("groupAgentsByBrand", () => {
  it("groups forms in first-seen order and strips form suffixes from the brand label", () => {
    const grouped = groupAgentsByBrand([
      { id: "claude-app", label: "Claude Code (App)", kind: "app" as const },
      { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal" as const },
      { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal" as const },
      { id: "pi-terminal", label: "Pi (Terminal)", kind: "terminal" as const },
    ]);
    expect(grouped.map((b) => b.id)).toEqual(["claude", "codex", "pi"]);
    expect(grouped[0]).toMatchObject({
      id: "claude",
      label: "Claude Code",
      forms: [{ id: "claude-app" }, { id: "claude-terminal" }],
    });
    expect(grouped[1].forms).toHaveLength(1);
  });
});

describe("getEnabledLocalAgents / setEnabledLocalAgents (config-store)", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("returns null when never set", async () => {
    expect(await getEnabledLocalAgents()).toBe(null);
  });

  it("round-trips a set list", async () => {
    await setEnabledLocalAgents(["claude", "codex"]);
    expect(await getEnabledLocalAgents()).toEqual(["claude", "codex"]);
  });
});
