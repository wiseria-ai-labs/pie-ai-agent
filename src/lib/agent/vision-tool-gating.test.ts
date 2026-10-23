import { describe, expect, it } from "vitest";
import { filterToolsByVision } from "./loop";
import { BUILT_IN_TOOLS, getMouseTools } from "./tools";
import { getToolClass, SCREENSHOT_TOOL_NAMES } from "./tool-names";

// #62 — fail-closed vision gating. The tool table offered to the LLM must
// only include the screenshot tools (capture_visible_tab /
// capture_fullpage_tab) for models KNOWN to support vision. Non-vision
// (`false`) and unknown-vision (`undefined`, e.g. custom provider) models
// must never see them — being offered a tool is itself a "you may call this"
// signal the model cannot otherwise verify against host-side registry data.

const sampleTools = [
  { name: "click" },
  { name: "capture_visible_tab" },
  { name: "capture_fullpage_tab" },
  { name: "click_at" },
  { name: "done" },
];

describe("#62 — filterToolsByVision (fail-closed)", () => {
  it("vision === true → screenshot tools ARE offered", () => {
    const names = filterToolsByVision(sampleTools, true).map((t) => t.name);
    expect(names).toContain("capture_visible_tab");
    expect(names).toContain("capture_fullpage_tab");
  });

  it("vision === false → screenshot tools are NOT offered", () => {
    const names = filterToolsByVision(sampleTools, false).map((t) => t.name);
    expect(names).not.toContain("capture_visible_tab");
    expect(names).not.toContain("capture_fullpage_tab");
  });

  it("vision === undefined → screenshot tools are NOT offered (fail-closed)", () => {
    const names = filterToolsByVision(sampleTools, undefined).map((t) => t.name);
    expect(names).not.toContain("capture_visible_tab");
    expect(names).not.toContain("capture_fullpage_tab");
  });

  it("never drops non-screenshot tools regardless of vision state", () => {
    for (const vision of [true, false, undefined] as const) {
      const names = filterToolsByVision(sampleTools, vision).map((t) => t.name);
      expect(names).toContain("click");
      expect(names).toContain("done");
    }
  });
});

describe("#62 — cross-layer invariant on real BUILT_IN_TOOLS", () => {
  const screenshotNames = new Set<string>(SCREENSHOT_TOOL_NAMES);

  it("non-vision (false) tool definitions never contain a screenshot tool", () => {
    const names = filterToolsByVision(BUILT_IN_TOOLS, false).map((t) => t.name);
    for (const s of names) expect(screenshotNames.has(s)).toBe(false);
  });

  it("unknown-vision (undefined) tool definitions never contain a screenshot tool", () => {
    const names = filterToolsByVision(BUILT_IN_TOOLS, undefined).map((t) => t.name);
    for (const s of names) expect(screenshotNames.has(s)).toBe(false);
  });

  it("vision (true) tool definitions still expose both screenshot tools (regression)", () => {
    const names = filterToolsByVision(BUILT_IN_TOOLS, true).map((t) => t.name);
    for (const s of SCREENSHOT_TOOL_NAMES) expect(names).toContain(s);
  });
});

describe("click_at is vision-only", () => {
  it("vision false / undefined → click_at filtered out; true → offered", () => {
    expect(filterToolsByVision(sampleTools, false).map((t) => t.name)).not.toContain("click_at");
    expect(filterToolsByVision(sampleTools, undefined).map((t) => t.name)).not.toContain("click_at");
    expect(filterToolsByVision(sampleTools, true).map((t) => t.name)).toContain("click_at");
  });

  it("real getMouseTools: click_at present but gated; click/hover always offered", () => {
    const mouse = getMouseTools({
      acquireSession: () => Promise.reject(new Error("unused")),
      sessionId: "S",
      requestConsent: async () => true,
    });
    expect(mouse.map((t) => t.name)).toContain("click_at");
    const names = filterToolsByVision(mouse, false).map((t) => t.name);
    expect(names).toEqual(["hover", "click"]);
  });

  it("click_at stays out of SCREENSHOT_TOOL_NAMES and is write-class", () => {
    expect((SCREENSHOT_TOOL_NAMES as readonly string[]).includes("click_at")).toBe(false);
    expect(getToolClass("click_at")).toBe("write");
  });
});
