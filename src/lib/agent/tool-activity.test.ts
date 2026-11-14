import { describe, expect, it } from "vitest";
import {
  KNOWN_BUILT_IN_TOOL_NAMES,
  KNOWN_EDITOR_TOOL_NAMES,
  KNOWN_KEYBOARD_TOOL_NAMES,
  LOCAL_BRIDGE_TOOL_NAMES,
} from "./tool-names";
import { makeT } from "@/lib/i18n";
import { capsuleActivityText } from "@/content/overlay/capsule";
import type { OverlayUiStrings } from "@/lib/overlay/protocol";
import {
  TOOL_ACTIVITY,
  TOOL_ACTIVITY_DICT_KEY,
  activityTextFor,
  toolActivityKey,
} from "./tool-activity";

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


describe("one copy for both surfaces", () => {
  const ALL_TOOLS = [
    ...KNOWN_BUILT_IN_TOOL_NAMES,
    ...KNOWN_KEYBOARD_TOOL_NAMES,
    ...KNOWN_EDITOR_TOOL_NAMES,
    ...LOCAL_BRIDGE_TOOL_NAMES,
  ];

  it("dictionary keys cover every activity", () => {
    for (const key of Object.values(TOOL_ACTIVITY)) {
      expect(TOOL_ACTIVITY_DICT_KEY[key], key).toBe(`overlay.capsule.activity.${key}`);
    }
  });

  it("side panel and capsule render identical copy for every registered tool", () => {
    const t = makeT("en");
    const strings = {
      activityReadPage: t(TOOL_ACTIVITY_DICT_KEY.readPage),
      activityActPage: t(TOOL_ACTIVITY_DICT_KEY.actPage),
      activityOpenPage: t(TOOL_ACTIVITY_DICT_KEY.openPage),
      activityReadPdf: t(TOOL_ACTIVITY_DICT_KEY.readPdf),
      activitySearchBookmarks: t(TOOL_ACTIVITY_DICT_KEY.searchBookmarks),
      activitySearchHistory: t(TOOL_ACTIVITY_DICT_KEY.searchHistory),
      activityBookmarks: t(TOOL_ACTIVITY_DICT_KEY.bookmarks),
      activityMemory: t(TOOL_ACTIVITY_DICT_KEY.memory),
      activityMonitor: t(TOOL_ACTIVITY_DICT_KEY.monitor),
      activityOther: t(TOOL_ACTIVITY_DICT_KEY.other),
    } as unknown as OverlayUiStrings;
    for (const tool of ALL_TOOLS) {
      expect(activityTextFor(tool, t), tool).toBe(capsuleActivityText(tool, strings));
    }
  });
});
