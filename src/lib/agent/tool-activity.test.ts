import { describe, expect, it } from "vitest";
import {
  KNOWN_BUILT_IN_TOOL_NAMES,
  KNOWN_EDITOR_TOOL_NAMES,
  KNOWN_KEYBOARD_TOOL_NAMES,
  LOCAL_BRIDGE_TOOL_NAMES,
} from "./tool-names";
import { TOOL_ACTIVITY, toolActivityKey } from "./tool-activity";

describe("capsule activity copy", () => {
  it("classifies every registered tool (a new tool must declare one)", () => {
    for (const name of [
      ...KNOWN_BUILT_IN_TOOL_NAMES,
      ...KNOWN_KEYBOARD_TOOL_NAMES,
      ...KNOWN_EDITOR_TOOL_NAMES,
      ...LOCAL_BRIDGE_TOOL_NAMES,
    ]) {
      expect(TOOL_ACTIVITY[name], name).toBeDefined();
    }
  });

  it("maps the families the capsule copy is written for", () => {
    // reading the page
    for (const name of ["read_page", "find_target", "read_struct", "read_target", "capture_visible_tab"]) {
      expect(toolActivityKey(name), name).toBe("readPage");
    }
    // operating the page
    for (const name of ["click", "type", "select", "scroll", "press_key", "dispatch_keyboard_input", "hover"]) {
      expect(toolActivityKey(name), name).toBe("actPage");
    }
    // opening / switching pages
    for (const name of ["open_url", "activate_tab", "switch_to_new_tab"]) {
      expect(toolActivityKey(name), name).toBe("openPage");
    }
    expect(toolActivityKey("read_pdf")).toBe("readPdf");
    expect(toolActivityKey("search_pdf")).toBe("readPdf");
    expect(toolActivityKey("search_bookmarks")).toBe("searchBookmarks");
    expect(toolActivityKey("search_history")).toBe("searchHistory");
    // create/update/plan all read as "整理书签"
    expect(toolActivityKey("create_bookmark")).toBe("bookmarks");
    expect(toolActivityKey("update_bookmark")).toBe("bookmarks");
    expect(toolActivityKey("propose_bookmark_plan")).toBe("bookmarks");
    expect(toolActivityKey("remember")).toBe("memory");
    expect(toolActivityKey("forget")).toBe("memory");
    expect(toolActivityKey("propose_monitor")).toBe("monitor");
    expect(toolActivityKey("update_monitor")).toBe("monitor");
    expect(toolActivityKey("run_skill_script")).toBe("other");
  });

  it("falls back to the generic line for unknown tools", () => {
    expect(toolActivityKey("not_a_tool")).toBe("other");
  });
});
