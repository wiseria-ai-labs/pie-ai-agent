/**
 * Tool-arg coercion: a weak model's string/exponent tabId reaches the handler
 * as a number, and the coerced args are what history/panel events record.
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

const probeHandler = vi.fn(async (_args: unknown) => ({ success: true, observation: "ok" }));

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
      name: "probe_tab",
      description: "probe",
      parameters: {
        type: "object",
        properties: { tabId: { type: "integer" }, verbose: { type: "boolean" } },
        required: ["tabId"],
      },
      handler: (args: unknown) => probeHandler(args),
    },
    {
      name: "probe_opt",
      description: "probe with optional tabId",
      parameters: {
        type: "object",
        properties: { tabId: { type: "integer" }, query: { type: "string" } },
      },
      handler: (args: unknown) => probeHandler(args),
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
  VISION_ONLY_TOOL_NAMES: [],
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
vi.mock("./text-tool-invocation", () => ({
  parseTextToolInvocations: vi.fn(() => []),
}));
const { streamChatArgs } = vi.hoisted(() => ({ streamChatArgs: [] as unknown[][] }));
vi.mock("../model-router", () => ({
  streamChat: (...args: unknown[]) => {
    streamChatArgs.push(args);
    return streamChatImpl.current(...(args as []));
  },
}));

describe("runAgentLoop tool-arg coercion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probeHandler.mockClear();
    streamChatArgs.length = 0;
  });

  it("handler receives numeric tabId when the model sent an exponent string", async () => {
    let call = 0;
    streamChatImpl.current = async function* () {
      call++;
      if (call === 1) {
        const raw = '{"tabId":"1.044214277e+09","verbose":"true"}';
        yield { type: "tool-call-start", id: "call_p", index: 0, name: "probe_tab" };
        yield { type: "tool-call-delta", index: 0, argsDelta: raw };
        yield { type: "tool-call-end", index: 0 };
        yield { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text-delta", text: "all done" };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };

    const { runAgentLoop } = await import("./loop");
    const emitted: Array<{ type: string; [k: string]: unknown }> = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg as { type: string }); };
    const snaps: SessionAgentState[] = [];

    await runAgentLoop({
      emit,
      task: "probe",
      modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "sk-test", vision: false },
      signal: new AbortController().signal,
      sessionId: "test-coerce-1",
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
      onStepSnapshot: async (s) => { snaps.push(s); },
    });

    expect(probeHandler).toHaveBeenCalledTimes(1);
    expect(probeHandler.mock.calls[0][0]).toEqual({ tabId: 1044214277, verbose: true });

    const step = emitted.find((m) => m.type === "agent-step" && m.tool === "probe_tab");
    expect(step?.args).toEqual({ tabId: 1044214277, verbose: true });

    const withHistory = snaps.find((s) =>
      (s.agentMessages ?? []).some((m) =>
        m.role === "assistant" && Array.isArray(m.content) &&
        (m.content as ContentBlock[]).some((b) => b.type === "tool_use"),
      ),
    );
    expect(withHistory).toBeDefined();
    const toolUse = withHistory!.agentMessages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : []))
      .find((b) => b.type === "tool_use");
    expect((toolUse as { input: unknown }).input).toEqual({ tabId: 1044214277, verbose: true });
  });

  async function runOne(tool: string, raw: string) {
    let call = 0;
    streamChatImpl.current = async function* () {
      call++;
      if (call === 1) {
        yield { type: "tool-call-start", id: "call_o", index: 0, name: tool };
        yield { type: "tool-call-delta", index: 0, argsDelta: raw };
        yield { type: "tool-call-end", index: 0 };
        yield { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text-delta", text: "all done" };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };
    const { runAgentLoop } = await import("./loop");
    const emitted: Array<{ type: string; [k: string]: unknown }> = [];
    await runAgentLoop({
      emit: ((msg) => { emitted.push(msg as { type: string }); }) as AgentEmit,
      task: "probe",
      modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "sk-test", vision: false },
      signal: new AbortController().signal,
      sessionId: "test-coerce-opt",
      pinnedTabs: [{ tabId: 7, origin: "https://example.com" }],
      initialFocusTabId: 7,
      onStepSnapshot: async () => {},
    });
    return emitted;
  }

  it("fills a left-out optional tabId with the task's current tab", async () => {
    const emitted = await runOne("probe_opt", '{"query":"§"}');
    expect(probeHandler.mock.calls[0][0]).toEqual({ query: "§", tabId: 7 });
    const step = emitted.find((m) => m.type === "agent-step" && m.tool === "probe_opt");
    expect(step?.args).toEqual({ query: "§", tabId: 7 });
  });

  it("keeps an explicit optional tabId", async () => {
    await runOne("probe_opt", '{"tabId":3}');
    expect(probeHandler.mock.calls[0][0]).toEqual({ tabId: 3 });
  });

  it("fills a left-out tabId even when the tool's schema requires it", async () => {
    const emitted = await runOne("probe_tab", '{"verbose":true}');
    expect(probeHandler.mock.calls[0][0]).toEqual({ verbose: true, tabId: 7 });
    const step = emitted.find((m) => m.type === "agent-step" && m.tool === "probe_tab");
    expect(step?.args).toEqual({ verbose: true, tabId: 7 });
  });

  it("replaces a non-numeric tabId with the task's current tab", async () => {
    await runOne("probe_tab", '{"tabId":"current"}');
    expect(probeHandler.mock.calls[0][0]).toEqual({ tabId: 7 });
  });

  it("offers tabId as optional on the wire", async () => {
    await runOne("probe_tab", '{"tabId":7}');
    const defs = streamChatArgs[0][3] as Array<{ name: string; parameters: { required?: string[]; properties: { tabId: { description?: string } } } }>;
    const probe = defs.find((d) => d.name === "probe_tab")!;
    expect(probe.parameters.required ?? []).not.toContain("tabId");
    expect(probe.parameters.properties.tabId.description).toMatch(/Leave out for the current tab/);
  });
});
