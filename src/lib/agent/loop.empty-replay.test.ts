/**
 * #474: empty completion (no text, no tool call) is replayed with the same request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEmit } from "./loop";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { ContentBlock } from "@/lib/model-router/types";

const chromeMock = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.com", title: "Test" }) },
  scripting: { executeScript: vi.fn().mockResolvedValue([{ result: "<body>hi</body>" }]) },
  storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
  runtime: { id: "test-ext-id", getURL: vi.fn((p: string) => `chrome-extension://test/${p}`) },
  i18n: { getUILanguage: vi.fn(() => "en") },
};
// @ts-expect-error global chrome stub
globalThis.chrome = chromeMock;

const webSearchHandler = vi.fn(async () => ({ success: true, observation: "should-not-run" }));

const { streamChatImpl } = vi.hoisted(() => ({
  streamChatImpl: {
    current: async function* () {
      yield { type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
    } as () => AsyncGenerator<unknown>,
  },
}));

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
  BUILT_IN_TOOLS: [
    {
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
      handler: () => webSearchHandler(),
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
  getToolGroup: vi.fn(() => "core"),
  TOOL_GROUPS: {},
}));
vi.mock("./untrusted-wrappers", () => ({
  escapeUntrustedWrappers: vi.fn((s: string) => s),
  escapeTrustedWrappers: vi.fn((s: string) => s),
}));
vi.mock("./prompt", () => ({
  buildAgentSystemPrompt: vi.fn(() => "sys"),
  buildObservationMessage: vi.fn((obs: string) => ({ role: "user", content: obs })),
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
  estimateTokens: vi.fn(() => 0),
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
}));
vi.mock("../sessions/pin-state", () => ({
  addPinToMeta: vi.fn(async () => {}),
  removePinFromMeta: vi.fn(async () => {}),
}));
vi.mock("../sessions/pending-instructions", () => ({
  drainPending: vi.fn(async () => []),
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
vi.mock("./text-tool-invocation", () => ({
  parseTextToolInvocations: vi.fn(() => []),
}));
vi.mock("../model-router", () => ({
  streamChat: (...args: unknown[]) => streamChatImpl.current(...(args as [])),
}));

const { retryTiming } = await import("@/lib/model-router/providers/_shared/fetch-retry");

async function run(signal = new AbortController().signal) {
  const { runAgentLoop } = await import("./loop");
  const emitted: Array<{ type: string; [k: string]: unknown }> = [];
  const emit: AgentEmit = (msg) => { emitted.push(msg as { type: string }); };
  const snaps: SessionAgentState[] = [];
  await runAgentLoop({
    emit,
    task: "hi",
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "sk-test", vision: false },
    signal,
    sessionId: "test-empty-replay",
    pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
    initialFocusTabId: 1,
    onStepSnapshot: async (s) => { snaps.push(s); },
  });
  return { emitted, snaps };
}

/** streamChat that returns `emptyTimes` empty completions, then a text reply. */
function emptyThen(emptyTimes: number) {
  let calls = 0;
  const histories: unknown[] = [];
  streamChatImpl.current = async function* (...args: unknown[]) {
    histories.push(JSON.stringify(args[1]));
    if (calls++ < emptyTimes) {
      yield { type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 0 } };
      return;
    }
    yield { type: "text-delta", text: "hello" };
    yield { type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  } as unknown as () => AsyncGenerator<unknown>;
  return { calls: () => calls, histories };
}

describe("runAgentLoop empty-completion replay", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replays the same request and continues; no empty assistant message in history", async () => {
    const sleep = vi.spyOn(retryTiming, "sleep");
    const s = emptyThen(2);
    const { emitted } = await run();
    expect(s.calls()).toBe(3);
    // Identical request each time ⇒ the empty attempts wrote nothing to history.
    expect(new Set(s.histories).size).toBe(1);
    expect(s.histories[0]).not.toContain('"role":"assistant"');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1500, 3000]);
    expect(emitted.some((m) => m.type === "chat-error")).toBe(false);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
    sleep.mockRestore();
  });

  it("reports the existing empty-response error after replays are exhausted", async () => {
    const s = emptyThen(99);
    const { emitted } = await run();
    expect(s.calls()).toBe(3);
    const err = emitted.find((m) => m.type === "chat-error");
    expect(String(err?.error)).toContain("empty response");
  });

  it("abort during the replay wait stops without another request", async () => {
    const ac = new AbortController();
    const sleep = vi.spyOn(retryTiming, "sleep").mockImplementation(async () => {
      ac.abort();
      throw new Error("aborted");
    });
    const s = emptyThen(99);
    const { emitted } = await run(ac.signal);
    expect(s.calls()).toBe(1);
    expect(emitted.some((m) => m.type === "chat-error")).toBe(false);
    sleep.mockRestore();
  });
});
