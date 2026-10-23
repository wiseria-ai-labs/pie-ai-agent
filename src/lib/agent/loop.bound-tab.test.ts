/**
 * The agent stays on ITS tab when the user switches windows / workspaces.
 *
 * Chrome answers "the active tab" from a service worker with the active tab
 * of the LAST-FOCUSED window, so anything resolving the task's tab that way
 * follows the user's focus to whatever they look at next. The task is bound
 * to the tab the panel was on when the user pressed send (anchorTabId /
 * pinnedTabs) and keeps using it; losing it pauses the task.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEmit, AgentLoopContext } from "./loop";
import type { StreamEvent } from "../model-router/types";

type FakeTab = { id: number; windowId: number; active: boolean; url: string; title: string };
const { browser, readPageCalls } = vi.hoisted(() => ({
  browser: { tabs: [] as FakeTab[], focusedWindowId: 1 },
  readPageCalls: [] as number[],
}));

// ---------------------------------------------------------------------------
// Minimal chrome stubs (MV3 service-worker environment)
// ---------------------------------------------------------------------------
const chromeMock = {
  tabs: {
    get: vi.fn(async (id: number) => {
      const t = browser.tabs.find((x) => x.id === id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return { ...t };
    }),
    // "The active tab" as Chrome would answer it from a service worker: the
    // active tab of the LAST-FOCUSED window.
    query: vi.fn(async (q: { active?: boolean }) =>
      q.active ? browser.tabs.filter((t) => t.active && t.windowId === browser.focusedWindowId) : browser.tabs,
    ),
  },
  windows: { getCurrent: vi.fn(async () => ({ id: browser.focusedWindowId })) },
  scripting: { executeScript: vi.fn().mockResolvedValue([{ result: "<body>hi</body>" }]) },
  storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
  runtime: { id: "test-ext-id", getURL: vi.fn((p: string) => `chrome-extension://test/${p}`) },
  i18n: { getUILanguage: vi.fn(() => "en") },
};
// @ts-expect-error global chrome stub
globalThis.chrome = chromeMock;

// ---------------------------------------------------------------------------
// Module mocks — only the pieces loop.ts touches outside its own logic
// ---------------------------------------------------------------------------
vi.mock("../../background/image-cache", () => ({
  addImage: vi.fn(),
  evictSession: vi.fn(),
}));
vi.mock("../files/output-store", () => ({ putArtifact: vi.fn() }));
vi.mock("./tools/screenshot", () => ({
  dispatchCaptureVisibleTab: vi.fn(),
  dispatchCaptureFullPageTab: vi.fn(),
}));
vi.mock("./image-hydration", () => ({ hydrateAttachments: vi.fn(async (msgs: unknown) => msgs) }));
vi.mock("./tools", () => ({
  // A stand-in read_page that records which tab the loop handed it.
  BUILT_IN_TOOLS: [
    {
      name: "read_page",
      description: "read the page",
      parameters: { type: "object", properties: {} },
      handler: async (_args: unknown, ctx: { tabId: number }) => {
        readPageCalls.push(ctx.tabId);
        return { success: true, observation: `read tab ${ctx.tabId}` };
      },
    },
  ],
  getKeyboardTools: vi.fn(() => []),
  getMouseTools: vi.fn(() => []),
  getEditorTools: vi.fn(() => []),
  isKeyboardToolName: vi.fn(() => false),
}));
vi.mock("./tool-names", () => ({
  getToolClass: vi.fn(() => "read"),
  SCREENSHOT_TOOL_NAMES: [],
  SCREENSHOT_TOOL_NAME_SET: new Set<string>(),
  // Vision-only tool list (used once PR #462 lands).
  VISION_ONLY_TOOL_NAMES: [],
  // Task 7 — disclosure selectTools() resolves each tool's group via
  // getToolGroup. "core" keeps every tool selected (core is always active).
  getToolGroup: vi.fn(() => "core"),
  TOOL_GROUPS: {},
}));
vi.mock("./untrusted-wrappers", () => ({
  escapeUntrustedWrappers: vi.fn((s: string) => s),
  escapeTrustedWrappers: vi.fn((s: string) => s),
}));
vi.mock("./prompt", async (importOriginal) => ({
  buildAgentSystemPrompt: vi.fn(() => "sys"),
  // The real per-step header (Tab / Current URL / Page title) — what this file checks.
  buildObservationMessage: (await importOriginal<typeof import("./prompt")>()).buildObservationMessage,
  buildCurrentTimeBlock: vi.fn((now: number) => `<current_time>epochMs=${now}</current_time>`),
}));
vi.mock("./window", () => ({
  applySlidingWindow: vi.fn((hist: unknown) => hist),
}));
vi.mock("./elide-stale-observations", () => ({
  elideStaleObservations: vi.fn((hist: unknown) => hist),
}));
vi.mock("./window-token-budget", () => ({
  applyTokenBudget: vi.fn(async (hist: unknown) => hist),
  estimateTokens: vi.fn(() => 0), // 只服务 [ctx] 诊断日志
}));
vi.mock("./compact-react-window", () => ({
  compactReactWindow: vi.fn(async (hist: unknown) => hist),
  createDefaultSummarizer: vi.fn(),
}));
vi.mock("../model-router/providers/registry", () => ({
  resolveModelMeta: vi.fn(() => ({
    provider: "openai",
    model: "gpt-4",
    vision: false,
    tools: true,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  })),
}));
vi.mock("./history-validation", () => ({
  validateAndRepairAdjacentRoles: vi.fn((hist: unknown) => ({ repaired: hist, violations: [] })),
  dropEmptyMessages: vi.fn((hist: unknown) => hist),
}));
vi.mock("../cdp-input-enabled", () => ({ isCdpInputEnabled: vi.fn(async () => false) }));
vi.mock("../cdp-input-onboarding", () => ({ requestCdpInputConsent: vi.fn() }));
vi.mock("../local-file-request", () => ({ requestLocalFileFromPanel: vi.fn() }));
vi.mock("./tools/files", () => ({
  buildReadLocalFileTool: vi.fn(() => ({ name: "read_local_file", description: "", parameters: {}, execute: vi.fn() })),
  buildRequestLocalFileTool: vi.fn(() => ({ name: "request_local_file", description: "", parameters: {}, execute: vi.fn() })),
  buildOutputFileTool: vi.fn(() => ({ name: "output_file", description: "", parameters: {}, execute: vi.fn() })),
}));
vi.mock("./tools/scratchpad", () => ({ buildScratchpadTools: vi.fn(() => []) }));
vi.mock("../scratchpad/service", () => ({
  saveRecords: vi.fn(),
  updateNotes: vi.fn(),
  readScratchpadRecords: vi.fn(),
  clearScratchpadCollections: vi.fn(),
  getOverview: vi.fn(),
}));
vi.mock("../scratchpad/sql-bridge", () => ({ queryScratchpad: vi.fn() }));
vi.mock("@/background/skill-source", () => ({
  getEnabledSkillEntries: vi.fn(async () => []),
  // run_skill_script (Slice 3 Task 5) is now assembled per-run in loop.ts and
  // reads getActiveSkillSource directly (bypassing the "./tools" mock below,
  // which only stubs the static BUILT_IN_TOOLS array) — stub a minimal source
  // so tool construction doesn't throw; no test here exercises the handler.
  getActiveSkillSource: vi.fn(() => ({
    mode: "idb",
    list: vi.fn(async () => []),
    readFile: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
  })),
}));
vi.mock("../pdf/detect", () => ({ isFilePdfUrl: vi.fn(() => false), isPdfTab: vi.fn(() => false), isPdfTabAsync: vi.fn(async () => false) }));
vi.mock("../../background/cdp-session", () => ({
  acquireCdpSession: vi.fn(async () => null),
}));
vi.mock("../sessions/storage", () => ({
  getSessionMeta: vi.fn(async () => null),
  setSessionMeta: vi.fn(async () => {}),
  getSessionAgent: vi.fn(async () => null),
  setSessionAgent: vi.fn(async () => {}),
  // Single-transaction agent-record writer (used once PR #464 lands).
  updateSessionAgent: vi.fn(async () => true),
}));
vi.mock("../sessions/pin-state", () => ({
  addPinToMeta: vi.fn(async () => {}),
  removePinFromMeta: vi.fn(async () => {}),
}));
vi.mock("../sessions/pending-instructions", () => ({
  drainPending: vi.fn(async () => []),
  // Task-end queue check (used once PR #464 lands).
  hasPending: vi.fn(async () => false),
}));
vi.mock("./loop-drain", () => ({ buildMidTaskUserMessage: vi.fn(() => null) }));
vi.mock("@/background/instruction-broadcast", () => ({
  broadcastInstructionState: vi.fn(),
}));
vi.mock("./synthesize-agent-turn", () => ({
  synthesizeAgentTurnText: vi.fn(() => null),
}));
vi.mock("./wait-for-url-settle", () => ({
  waitForUrlSettle: vi.fn(async () => ({ url: "https://example.com", settled: true })),
}));
vi.mock("./assistant-blocks", () => ({
  assembleAssistantBlocks: vi.fn(() => []),
}));
vi.mock("./text-tool-invocation", () => ({
  parseTextToolInvocations: vi.fn(() => []),
}));



// Each streamChat call plays the next scripted turn.
const turns: StreamEvent[][] = [];
vi.mock("../model-router", () => ({
  streamChat: vi.fn(async function* () {
    const script = turns.shift() ?? [{ type: "text-delta", text: "done" }, { type: "done", stopReason: "end" }];
    for (const ev of script) yield ev;
  }),
}));

const readPageTurn = (id: string): StreamEvent[] => [
  { type: "tool-call-start", id, index: 0, name: "read_page" },
  { type: "tool-call-delta", index: 0, argsDelta: "{}" },
  { type: "tool-call-end", index: 0 },
  { type: "done", stopReason: "tool_calls" },
];
const answerTurn: StreamEvent[] = [{ type: "text-delta", text: "All done." }, { type: "done", stopReason: "end" }];

const TAB_A: FakeTab = { id: 101, windowId: 1, active: true, url: "https://classroom.google.com/c/1", title: "Algebra" };
const TAB_B: FakeTab = { id: 202, windowId: 2, active: true, url: "https://mail.google.com/", title: "Inbox" };

type Msg = { type: string; [k: string]: unknown };
function makeCtx(over: Partial<AgentLoopContext> = {}) {
  const emitted: Msg[] = [];
  const ctx = {
    emit: ((m) => { emitted.push(m as unknown as Msg); }) as AgentEmit,
    task: "Read my class",
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "sk-test", vision: false },
    signal: new AbortController().signal,
    sessionId: "s-bound",
    onStepSnapshot: async () => {},
    ...over,
  } as AgentLoopContext;
  return { ctx, emitted };
}

/** The per-step observation the model saw on turn `n` (0-based). */
async function observationOfTurn(n: number): Promise<string> {
  const { streamChat } = await import("../model-router");
  const history = vi.mocked(streamChat).mock.calls[n][1] as Array<{ role: string; content: unknown }>;
  return JSON.stringify(history[history.length - 1].content);
}

describe("agent loop — bound tab vs. the user's window focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turns.length = 0;
    readPageCalls.length = 0;
    browser.tabs = [{ ...TAB_A }, { ...TAB_B }];
    browser.focusedWindowId = 1; // user is in window 1 when they press send
  });

  it("start in tab A, user focuses tab B in another window → the next read_page still reads A", async () => {
    const { runAgentLoop } = await import("./loop");
    // Turn 1 reads the page; then the user switches to window 2 (tab B).
    turns.push(readPageTurn("t1"));
    turns.push(readPageTurn("t2"));
    turns.push(answerTurn);
    const { streamChat } = await import("../model-router");
    const realImpl = vi.mocked(streamChat).getMockImplementation()!;
    let calls = 0;
    vi.mocked(streamChat).mockImplementation(((...args: Parameters<typeof realImpl>) => {
      if (++calls === 2) browser.focusedWindowId = 2; // focus moved before step 2
      return realImpl(...args);
    }) as typeof realImpl);

    // The window switch happens even BEFORE the task starts (send → switch).
    browser.focusedWindowId = 2;
    const { ctx, emitted } = makeCtx({ anchorTabId: TAB_A.id });
    await runAgentLoop(ctx);

    expect(readPageCalls).toEqual([TAB_A.id, TAB_A.id]);
    for (const turn of [0, 1, 2]) {
      const obs = await observationOfTurn(turn);
      expect(obs).toContain(`Tab: ${TAB_A.id}`);
      expect(obs).toContain(TAB_A.url);
      expect(obs).not.toContain(TAB_B.url);
    }
    // never asked Chrome for "the active tab" once anchored
    const { chrome } = globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } };
    expect(chrome.tabs.query.mock.calls.filter((c) => (c[0] as { active?: boolean })?.active)).toHaveLength(0);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
  });

  it("a pinned task keeps its pin when the user switches windows mid-task", async () => {
    const { runAgentLoop } = await import("./loop");
    turns.push(readPageTurn("t1"), readPageTurn("t2"), answerTurn);
    const { ctx } = makeCtx({ pinnedTabs: [{ tabId: TAB_A.id, origin: "https://classroom.google.com" }] });
    browser.focusedWindowId = 2;
    await runAgentLoop(ctx);
    expect(readPageCalls).toEqual([TAB_A.id, TAB_A.id]);
  });

  it("does not steal focus: no tabs.update / windows.update", async () => {
    const { runAgentLoop } = await import("./loop");
    const g = globalThis as unknown as { chrome: { tabs: Record<string, unknown>; windows: Record<string, unknown> } };
    g.chrome.tabs.update = vi.fn();
    g.chrome.windows.update = vi.fn();
    turns.push(readPageTurn("t1"), answerTurn);
    const { ctx } = makeCtx({ anchorTabId: TAB_A.id });
    browser.focusedWindowId = 2;
    await runAgentLoop(ctx);
    expect(g.chrome.tabs.update).not.toHaveBeenCalled();
    expect(g.chrome.windows.update).not.toHaveBeenCalled();
    delete g.chrome.tabs.update;
    delete g.chrome.windows.update;
  });

  it("bound tab closed → pauses with a clear message, never reads another tab", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    turns.push(readPageTurn("t1"), readPageTurn("t2"), answerTurn);
    const realImpl = vi.mocked(streamChat).getMockImplementation()!;
    vi.mocked(streamChat).mockImplementation(((...args: Parameters<typeof realImpl>) => {
      // the user closes tab A while the model thinks about step 1
      browser.tabs = browser.tabs.filter((t) => t.id !== TAB_A.id);
      return realImpl(...args);
    }) as typeof realImpl);
    const onLlmPause = vi.fn(async () => {});
    const { ctx, emitted } = makeCtx({ anchorTabId: TAB_A.id, onLlmPause });
    await runAgentLoop(ctx);

    expect(readPageCalls).toEqual([TAB_A.id]); // step 1 ran against A; nothing after
    expect(onLlmPause).toHaveBeenCalledWith(expect.objectContaining({ reason: "tab-closed" }));
    const paused = emitted.find((m) => m.type === "agent-paused")!;
    expect(paused).toMatchObject({ reason: "tab-closed" });
    expect(String(paused.error)).toContain(`tab ${TAB_A.id}`);
    expect(String(paused.error)).toContain(TAB_A.url);
    expect(emitted.some((m) => m.type === "agent-done-task")).toBe(false);
  });

  it("resuming after that pause doesn't pause again: the model is told the tab is gone", async () => {
    const { runAgentLoop } = await import("./loop");
    browser.tabs = [{ ...TAB_B }]; // A is gone
    turns.push(answerTurn);
    const onLlmPause = vi.fn(async () => {});
    const { ctx, emitted } = makeCtx({
      pinnedTabs: [{ tabId: TAB_A.id, origin: "https://classroom.google.com" }],
      onLlmPause,
      resumedAgentMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Read my class" },
      ],
      resumedFromStep: 1,
      resumedObservationPending: true,
    });
    await runAgentLoop(ctx);
    expect(onLlmPause).not.toHaveBeenCalled();
    const obs = await observationOfTurn(0);
    expect(obs).toContain("no longer available");
    expect(obs).not.toContain(TAB_B.url);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
  });

  it("headless runs (no pause hook) keep the advisory notice", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    turns.push(readPageTurn("t1"), answerTurn);
    const realImpl = vi.mocked(streamChat).getMockImplementation()!;
    vi.mocked(streamChat).mockImplementation(((...args: Parameters<typeof realImpl>) => {
      browser.tabs = browser.tabs.filter((t) => t.id !== TAB_A.id);
      return realImpl(...args);
    }) as typeof realImpl);
    const { ctx, emitted } = makeCtx({ anchorTabId: TAB_A.id });
    await runAgentLoop(ctx);
    expect(emitted.some((m) => m.type === "agent-paused")).toBe(false);
    expect(await observationOfTurn(1)).toContain("no longer available");
  });
});
