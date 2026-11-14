// What the agent is DOING, in user words — the capsule's step copy.
//
// Deliberately separate from the read/write class registry (`tool-names.ts`):
// that one answers "may two sessions touch this tab at once" (R7 lock), not
// "does this tool act on the page DOM" and definitely not "what should the
// user read". A bookmark write is a write for R7 purposes but touches no page
// at all — which is exactly the bug that collapsed the overlay into a capsule.
//
// Every registered tool MUST have an entry; the module throws at load when a
// new tool is added without one, and a test enumerates the registry too.

import type { DictKey } from "@/lib/i18n";
import {
  KNOWN_BUILT_IN_TOOL_NAMES,
  KNOWN_EDITOR_TOOL_NAMES,
  KNOWN_KEYBOARD_TOOL_NAMES,
  LOCAL_BRIDGE_TOOL_NAMES,
} from "./tool-names";

export type ToolActivityKey =
  | "readPage"
  | "actPage"
  | "openPage"
  | "readPdf"
  | "searchBookmarks"
  | "searchHistory"
  | "bookmarks"
  | "memory"
  | "monitor"
  | "other";

export const TOOL_ACTIVITY: Readonly<Record<string, ToolActivityKey>> = {
  // ── reading the page ──────────────────────────────────────────────────────
  read_page: "readPage",
  find_target: "readPage",
  read_struct: "readPage",
  read_target: "readPage",
  read_editor: "readPage",
  capture_visible_tab: "readPage",
  capture_fullpage_tab: "readPage",
  capture_video_frame: "readPage",

  // ── operating the page ────────────────────────────────────────────────────
  click: "actPage",
  hover: "actPage",
  type: "actPage",
  select: "actPage",
  scroll: "actPage",
  press_key: "actPage",
  dispatch_keyboard_input: "actPage",
  set_editor_value: "actPage",
  // Bulk extraction scrolls the page, so the user sees the page being worked.
  extract_records: "actPage",

  // ── opening / switching pages ─────────────────────────────────────────────
  open_url: "openPage",
  activate_tab: "openPage",
  switch_to_new_tab: "openPage",
  focus_tab: "openPage",

  // ── PDF ───────────────────────────────────────────────────────────────────
  read_pdf: "readPdf",
  search_pdf: "readPdf",
  get_pdf_outline: "readPdf",

  // ── bookmarks / history ───────────────────────────────────────────────────
  search_bookmarks: "searchBookmarks",
  get_bookmark_tree: "searchBookmarks",
  check_bookmark_links: "searchBookmarks",
  search_history: "searchHistory",
  create_bookmark: "bookmarks",
  update_bookmark: "bookmarks",
  propose_bookmark_plan: "bookmarks",
  propose_history_deletion: "other",

  // ── memory / monitors ─────────────────────────────────────────────────────
  remember: "memory",
  forget: "memory",
  recall_memory: "other",
  propose_monitor: "monitor",
  list_monitors: "monitor",
  update_monitor: "monitor",
  delete_monitor: "monitor",

  // ── everything else: generic "working on it" ─────────────────────────────
  wait: "other",
  done: "other",
  fail: "other",
  list_tabs: "other",
  close_tabs: "other",
  group_tabs: "other",
  ungroup_tabs: "other",
  move_tabs: "other",
  unpin_tab: "other",
  search_web: "other",
  output_file: "other",
  read_local_file: "other",
  request_local_file: "other",
  save_scratchpad: "other",
  update_scratchpad_notes: "other",
  read_scratchpad: "other",
  clear_scratchpad: "other",
  query_scratchpad: "other",
  create_skill: "other",
  update_skill: "other",
  delete_skill: "other",
  list_skills: "other",
  use_skill: "other",
  read_skill_file: "other",
  run_skill_script: "other",
  read_skill_output: "other",
  create_schedule: "other",
  update_schedule: "other",
  delete_schedule: "other",
  list_schedules: "other",
  propose_rewrite: "other",
  load_tools: "other",
  run_local_agent: "other",
  handoff_to_agent: "other",
};

/** Capsule line for a tool name; unknown tools fall back to "working…". */
export function toolActivityKey(tool: string): ToolActivityKey {
  return TOOL_ACTIVITY[tool] ?? "other";
}

/** The ONE dictionary key per activity. The side panel reads it with `useT()`,
 *  the SW ships it into OverlayUiStrings for the capsule — same keys, so the
 *  two surfaces can never drift into different copy. */
export const TOOL_ACTIVITY_DICT_KEY: Readonly<Record<ToolActivityKey, DictKey>> = {
  readPage: "overlay.capsule.activity.readPage",
  actPage: "overlay.capsule.activity.actPage",
  openPage: "overlay.capsule.activity.openPage",
  readPdf: "overlay.capsule.activity.readPdf",
  searchBookmarks: "overlay.capsule.activity.searchBookmarks",
  searchHistory: "overlay.capsule.activity.searchHistory",
  bookmarks: "overlay.capsule.activity.bookmarks",
  memory: "overlay.capsule.activity.memory",
  monitor: "overlay.capsule.activity.monitor",
  other: "overlay.capsule.activity.other",
};

/** Localized activity line for a tool (side panel / any `t`-driven surface). */
export function activityTextFor(tool: string, t: (key: DictKey) => string): string {
  return t(TOOL_ACTIVITY_DICT_KEY[toolActivityKey(tool)]);
}

// Build-time exhaustive check — a new registered tool without an activity
// line would silently render "正在处理…" everywhere, which is how the capsule
// ended up showing raw tool names in the first place.
for (const name of [
  ...KNOWN_BUILT_IN_TOOL_NAMES,
  ...KNOWN_KEYBOARD_TOOL_NAMES,
  ...KNOWN_EDITOR_TOOL_NAMES,
  ...LOCAL_BRIDGE_TOOL_NAMES,
]) {
  if (!(name in TOOL_ACTIVITY)) {
    throw new Error(
      `[tool-activity] tool "${name}" has no TOOL_ACTIVITY entry ` +
        `(src/lib/agent/tool-activity.ts). Add one so the capsule can say what ` +
        `the agent is doing without exposing tool args.`,
    );
  }
}
