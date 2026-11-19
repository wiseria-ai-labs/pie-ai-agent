import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n";
import { TOOL_ACTIVITY_DICT_KEY } from "@/lib/agent/tool-activity";
import { capsuleActivityText } from "@/content/overlay/capsule";
import type { OverlayUiStrings } from "@/lib/overlay/protocol";
import AgentStepLine from "./AgentStepLine";

afterEach(() => cleanup());

const tinyJpegBase64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAH//2Q==";

describe("AgentStepLine — image rendering (issue follow-up to #35/#39)", () => {
  beforeEach(() => {
    // Force the details element open so the unit test doesn't depend on the
    // user clicking the "详情" toggle. The image rendering happens inside
    // that block — this verifies the markup, not the toggle wiring.
  });

  it("renders the screenshot thumbnail in the details block when image prop is set", () => {
    render(
      <AgentStepLine
        tool="capture_visible_tab"
        args={{}}
        status="ok"
        observation="screenshot captured: 1372x1568 jpeg"
        image={{
          mediaType: "image/jpeg",
          data: tinyJpegBase64,
          width: 1372,
          height: 1568,
        }}
        defaultExpanded
      />,
    );
    const img = screen.getByRole("img", { name: /screenshot/i });
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe(`data:image/jpeg;base64,${tinyJpegBase64}`);
  });

  it("does not render an <img> when image prop is absent", () => {
    render(
      <AgentStepLine
        tool="click"
        args={{}}
        status="ok"
        observation="clicked"
        defaultExpanded
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders image only after the details toggle is expanded", () => {
    render(
      <AgentStepLine
        tool="capture_visible_tab"
        args={{}}
        status="ok"
        observation="screenshot captured: 1372x1568 jpeg"
        image={{
          mediaType: "image/jpeg",
          data: tinyJpegBase64,
          width: 1372,
          height: 1568,
        }}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    const toggle = screen.getByRole("button", { name: /details/i });
    fireEvent.click(toggle);
    expect(screen.getByRole("img", { name: /screenshot/i })).toBeTruthy();
  });
});

describe("AgentStepLine — remote step", () => {
  it("shows the remote badge and keeps observation collapsed by default", () => {
    render(
      <AgentStepLine
        tool="web_search"
        args={{ q: "pie" }}
        status="ok"
        observation="long remote output that must stay folded"
        remote
      />,
    );
    expect(screen.getByText("remote")).toBeTruthy();
    expect(screen.queryByText("long remote output that must stay folded")).toBeNull();
  });
});


describe("AgentStepLine — activity copy shared with the capsule", () => {
  // The SW builds OverlayUiStrings from exactly these dictionary keys; the
  // side panel renders them through useT(). Same keys → same copy.
  const t = makeT("en");
  const capsuleStrings = {
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

  it("collapsed row shows human copy, never the tool name", () => {
    render(<AgentStepLine tool="read_page" args={{ mode: "atlas" }} status="pending" />);
    expect(screen.getByText("Reading the page")).toBeTruthy();
    expect(screen.queryByText("read_page")).toBeNull();
  });

  it("expanding keeps the raw tool name and args for debugging", () => {
    render(
      <AgentStepLine
        tool="create_bookmark"
        args={{ title: "Quarterly review", url: "https://example.com/x" }}
        status="ok"
        defaultExpanded
      />,
    );
    expect(screen.getByText("create_bookmark")).toBeTruthy();
    expect(screen.getByText(/"title": "Quarterly review"/)).toBeTruthy();
  });

  it("renders the same copy as the capsule for the same tools", () => {
    for (const tool of [
      "read_page",
      "click",
      "open_url",
      "read_pdf",
      "search_bookmarks",
      "search_history",
      "create_bookmark",
      "remember",
      "propose_monitor",
      "run_skill_script",
      "not_a_tool",
    ]) {
      cleanup();
      render(<AgentStepLine tool={tool} args={{}} status="ok" />);
      expect(screen.getByText(capsuleActivityText(tool, capsuleStrings)), tool).toBeTruthy();
    }
  });
});
