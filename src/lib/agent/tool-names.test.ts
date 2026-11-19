import { describe, expect, it } from "vitest";
import {
  TOOL_CLASSES,
  TOOL_GROUPS,
  TOOL_SURFACES,
  getToolClass,
  getToolSurface,
  KNOWN_BUILT_IN_TOOL_NAMES,
  KNOWN_EDITOR_TOOL_NAMES,
  KNOWN_KEYBOARD_TOOL_NAMES,
  LOCAL_BRIDGE_TOOL_NAMES,
  PAGE_ATLAS_TOOL_NAMES,
  PAGE_SNAPSHOT_TOOL_NAMES,
  TAB_TOOL_NAMES,
} from "./tool-names";

describe("M3-U4 — TOOL_CLASSES registry", () => {
  it("classifies every Phase 2 DOM tool", () => {
    expect(TOOL_CLASSES.click).toBe("write");
    expect(TOOL_CLASSES.type).toBe("write");
    expect(TOOL_CLASSES.select).toBe("write");
    expect(TOOL_CLASSES.scroll).toBe("read");
    expect(TOOL_CLASSES.wait).toBe("read");
    expect(TOOL_CLASSES.done).toBe("read");
    expect(TOOL_CLASSES.fail).toBe("read");
  });

  it("classifies every Phase 2.5 keyboard tool as write", () => {
    for (const name of KNOWN_KEYBOARD_TOOL_NAMES) {
      expect(TOOL_CLASSES[name]).toBe("write");
    }
  });

  it("classifies skill meta tools (writes for create/update/delete, read for list)", () => {
    expect(TOOL_CLASSES.create_skill).toBe("write");
    expect(TOOL_CLASSES.update_skill).toBe("write");
    expect(TOOL_CLASSES.delete_skill).toBe("write");
    expect(TOOL_CLASSES.list_skills).toBe("read");
  });

  it("classifies skill mediation tools use_skill and read_skill_file as read", () => {
    expect(TOOL_CLASSES.use_skill).toBe("read");
    expect(TOOL_CLASSES.read_skill_file).toBe("read");
    expect(getToolClass("use_skill")).toBe("read");
    expect(getToolClass("read_skill_file")).toBe("read");
  });

  it("use_skill and read_skill_file are in KNOWN_BUILT_IN_TOOL_NAMES", () => {
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("use_skill");
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("read_skill_file");
  });

  it("classifies Phase 3 cross-tab tools per the R7 split", () => {
    // Reads
    expect(TOOL_CLASSES.list_tabs).toBe("read");
    expect(TOOL_CLASSES.activate_tab).toBe("read");
    // Writes
    expect(TOOL_CLASSES.close_tabs).toBe("write");
    expect(TOOL_CLASSES.group_tabs).toBe("write");
    expect(TOOL_CLASSES.ungroup_tabs).toBe("write");
    expect(TOOL_CLASSES.move_tabs).toBe("write");
  });

  it("classifies unpin_tab as read (mutates only the session pin pointer)", () => {
    // Issue #110 — like focus_tab, unpin_tab changes only internal session
    // state (removes a pin), never tab/page content, so it is read-class.
    expect(TOOL_CLASSES.unpin_tab).toBe("read");
    expect(getToolClass("unpin_tab")).toBe("read");
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("unpin_tab");
    expect(TAB_TOOL_NAMES).toContain("unpin_tab");
  });

  it("getToolClass defaults unknown names to read", () => {
    expect(getToolClass("foo_unknown_tool")).toBe("read");
    expect(getToolClass("some-arbitrary-name")).toBe("read");
  });

  it("getToolClass returns the registered class for known names", () => {
    expect(getToolClass("click")).toBe("write");
    expect(getToolClass("list_tabs")).toBe("read");
  });

  it("registers Page Atlas target tools as built-in tools and retires search_page", () => {
    expect(PAGE_SNAPSHOT_TOOL_NAMES).toEqual(["read_page"]);
    expect(PAGE_ATLAS_TOOL_NAMES).toEqual([
      "find_target",
      "read_struct",
      "read_target",
      "extract_records",
    ]);

    for (const name of PAGE_ATLAS_TOOL_NAMES) {
      expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain(name);
    }
    // The read-only target tools stay read; extract_records is write (see below).
    expect(getToolClass("find_target")).toBe("read");
    expect(getToolClass("read_struct")).toBe("read");
    expect(getToolClass("read_target")).toBe("read");

    expect(KNOWN_BUILT_IN_TOOL_NAMES).not.toContain("search_page");
    expect(TOOL_CLASSES).not.toHaveProperty("search_page");
  });

  it("extract_records is a known write-class core tool", () => {
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("extract_records");
    expect(TOOL_CLASSES.extract_records).toBe("write");
    expect(TOOL_GROUPS.extract_records).toBe("core");
  });

  it("every KNOWN_BUILT_IN_TOOL_NAMES entry has a class (build-time exhaustive)", () => {
    for (const name of KNOWN_BUILT_IN_TOOL_NAMES) {
      expect(TOOL_CLASSES[name]).toBeDefined();
    }
  });

  it("every TAB_TOOL_NAMES entry has a class (the test the G-1 gate is paired with)", () => {
    for (const name of TAB_TOOL_NAMES) {
      expect(TOOL_CLASSES[name]).toBeDefined();
    }
  });
});

describe("Phase 5 screenshot tools — names + classes", () => {
  it("capture_visible_tab and capture_fullpage_tab are registered", () => {
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("capture_visible_tab");
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("capture_fullpage_tab");
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("capture_video_frame");
  });
  it("screenshot tools are class=read (no tab-state mutation)", () => {
    expect(getToolClass("capture_visible_tab")).toBe("read");
    expect(getToolClass("capture_fullpage_tab")).toBe("read");
    expect(getToolClass("capture_video_frame")).toBe("read");
  });
});

describe("surface classification — does the tool touch the page DOM?", () => {
  it("classifies every registered tool (new tool without a class throws at load)", () => {
    for (const name of [
      ...KNOWN_BUILT_IN_TOOL_NAMES,
      ...KNOWN_KEYBOARD_TOOL_NAMES,
      ...KNOWN_EDITOR_TOOL_NAMES,
      ...LOCAL_BRIDGE_TOOL_NAMES,
    ]) {
      expect(TOOL_SURFACES[name], name).toBeDefined();
    }
  });

  it("only input/scroll tools count as page operations", () => {
    for (const name of [
      "click",
      "hover",
      "type",
      "select",
      "scroll",
      "press_key",
      "dispatch_keyboard_input",
      "set_editor_value",
    ]) {
      expect(getToolSurface(name), name).toBe("page");
    }
    for (const name of ["read_page", "extract_records", "open_url", "activate_tab"]) {
      expect(getToolSurface(name), name).not.toBe("page");
    }
  });

  it("screenshots are their own class", () => {
    for (const name of ["capture_visible_tab", "capture_fullpage_tab", "capture_video_frame"]) {
      expect(getToolSurface(name)).toBe("screenshot");
    }
  });

  it("bookmark/history/memory/monitor/PDF tools never move the overlay (the bug)", () => {
    for (const name of [
      "create_bookmark",
      "update_bookmark",
      "propose_bookmark_plan",
      "search_bookmarks",
      "search_history",
      "remember",
      "forget",
      "propose_monitor",
      "update_monitor",
      "read_pdf",
      "list_tabs",
      "run_skill_script",
    ]) {
      expect(getToolSurface(name), name).toBe("none");
    }
    // …and the write class alone must not imply a page surface.
    expect(getToolClass("create_bookmark")).toBe("write");
    expect(getToolSurface("create_bookmark")).toBe("none");
  });

  it("unknown tools are inert for the overlay", () => {
    expect(getToolSurface("some_future_tool")).toBe("none");
  });
});
