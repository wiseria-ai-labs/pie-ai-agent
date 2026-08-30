/**
 * remote-tool: peer-executed steps are recorded, not dispatched.
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

describe("runAgentLoop remote-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webSearchHandler.mockClear();
  });

  it("hits pending callId → does not execute, no tool_result, assistant has remote_tool, panel step is remote", async () => {
    const remoteItem = {
      function_call: { type: "function_call", call_id: "call_h", name: "web_search", arguments: '{"q":"x"}' },
      function_call_output: { type: "function_call_output", call_id: "call_h", output: "hits" },
    };
    streamChatImpl.current = async function* () {
      yield { type: "tool-call-start", id: "call_h", index: 0, name: "web_search" };
      yield { type: "tool-call-delta", index: 0, argsDelta: '{"q":"x"}' };
      yield { type: "tool-call-end", index: 0 };
      yield {
        type: "remote-tool",
        callId: "call_h",
        name: "web_search",
        args: '{"q":"x"}',
        output: "hits",
        item: remoteItem,
      };
      yield { type: "text-delta", text: "done searching" };
      yield { type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
    };

    const { runAgentLoop } = await import("./loop");
    const emitted: Array<{ type: string; [k: string]: unknown }> = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg as { type: string }); };
    const snaps: SessionAgentState[] = [];

    await runAgentLoop({
      emit,
      task: "search",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        vision: false,
      },
      signal: new AbortController().signal,
      sessionId: "test-remote-1",
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
      onStepSnapshot: async (s) => { snaps.push(s); },
    });

    expect(webSearchHandler).not.toHaveBeenCalled();

    const steps = emitted.filter((m) => m.type === "agent-step");
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent-step",
        tool: "web_search",
        status: "ok",
        remote: true,
        observation: "hits",
      }),
    ]));
    expect(steps.some((s) => s.status === "error")).toBe(false);
    expect(steps.some((s) => String(s.observation ?? "").includes("Unknown tool"))).toBe(false);

    const withHistory = snaps.find((s) => (s.agentMessages?.length ?? 0) > 0);
    expect(withHistory).toBeDefined();
    const assistant = withHistory!.agentMessages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const blocks = assistant!.content as ContentBlock[];
    expect(blocks.some((b) => b.type === "remote_tool")).toBe(true);
    expect(blocks.some((b) => b.type === "tool_use" && (b as { id: string }).id === "call_h")).toBe(false);

    const userTurns = withHistory!.agentMessages.filter((m) => m.role === "user");
    for (const u of userTurns) {
      if (typeof u.content === "string") continue;
      expect((u.content as ContentBlock[]).some((b) => b.type === "tool_result")).toBe(false);
    }
  });
});
