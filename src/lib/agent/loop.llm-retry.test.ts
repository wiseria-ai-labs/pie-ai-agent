/**
 * Agent-loop retry for LLM completions (llm-retry.ts wiring in loop.ts):
 * transient failures are retried with backoff, the panel is told
 * ("chat-llm-retry"), empty completions get a nudge after the first retry,
 * non-retryable errors fail at once, and exhausted retries PAUSE the task
 * (history kept, agent-paused emitted) instead of failing it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentEmit, AgentLoopContext } from "./loop";
import type { AgentMessage, StreamEvent } from "../model-router/types";
import { setRetrySleepForTests, EMPTY_RESPONSE_NUDGE } from "./llm-retry";

// ---------------------------------------------------------------------------
// Minimal chrome stubs (MV3 service-worker environment)
// ---------------------------------------------------------------------------
const chromeMock = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.com", title: "Test" }) },
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
  BUILT_IN_TOOLS: [],
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
vi.mock("./prompt", () => ({
  buildAgentSystemPrompt: vi.fn(() => "sys"),
  buildObservationMessage: vi.fn((obs: string) => ({ role: "user", content: obs })),
  // Block A — loop seeds the first user message via buildSeededTaskContent,
  // which calls buildCurrentTimeBlock; provide a deterministic stub here.
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


// Each call to streamChat plays the next scripted attempt.
const attempts: StreamEvent[][] = [];
const requests: AgentMessage[][] = [];
vi.mock("../model-router", () => ({
  streamChat: vi.fn(async function* (_cfg: unknown, messages: AgentMessage[]) {
    requests.push(structuredClone(messages));
    const script = attempts.shift() ?? [{ type: "text-delta", text: "fallback" }, { type: "done", stopReason: "end" }];
    for (const ev of script) yield ev;
  }),
}));

const OK: StreamEvent[] = [{ type: "text-delta", text: "All done." }, { type: "done", stopReason: "end" }];
const EMPTY: StreamEvent[] = [{ type: "done", stopReason: "end" }];
const err = (e: Partial<Extract<StreamEvent, { type: "error" }>>): StreamEvent[] => [
  { type: "error", error: "boom", ...e } as StreamEvent,
];

type Msg = { type: string; [k: string]: unknown };
let sleeps: number[] = [];
let restoreSleep: () => void;

function makeCtx(over: Partial<AgentLoopContext> = {}) {
  const emitted: Msg[] = [];
  const snapshots: unknown[] = [];
  const ctx = {
    emit: ((m) => { emitted.push(m as unknown as Msg); }) as AgentEmit,
    task: "Say hello",
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "sk-test", vision: false },
    signal: new AbortController().signal,
    sessionId: "s-retry",
    pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
    initialFocusTabId: 1,
    onStepSnapshot: async (s: unknown) => { snapshots.push(s); },
    ...over,
  } as AgentLoopContext;
  return { ctx, emitted, snapshots };
}

describe("agent loop — LLM retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attempts.length = 0;
    requests.length = 0;
    sleeps = [];
    restoreSleep = setRetrySleepForTests(async (ms) => { sleeps.push(ms); });
  });
  afterEach(() => restoreSleep());

  it("retries a 503 and finishes normally, telling the panel 1/5", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    attempts.push(err({ kind: "http", status: 503 }), OK);
    const { ctx, emitted } = makeCtx();
    await runAgentLoop(ctx);
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2);
    const retry = emitted.find((m) => m.type === "chat-llm-retry")!;
    expect(retry).toMatchObject({ attempt: 1, maxAttempts: 5, reason: "server", sessionId: "s-retry" });
    expect(emitted.some((m) => m.type === "chat-error")).toBe(false);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
    // backoff with jitter: base 2s → [1s, 2s]
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it("retries 429, network errors and timeouts", async () => {
    const { runAgentLoop } = await import("./loop");
    attempts.push(
      err({ kind: "ratelimit", status: 429 }),
      err({ kind: "network" }),
      err({ kind: "timeout" }),
      err({ kind: "http" }), // in-stream error frame, no status
      OK,
    );
    const { ctx, emitted } = makeCtx();
    await runAgentLoop(ctx);
    const retries = emitted.filter((m) => m.type === "chat-llm-retry");
    expect(retries.map((m) => m.reason)).toEqual(["ratelimit", "network", "timeout", "server"]);
    expect(retries.map((m) => m.attempt)).toEqual([1, 2, 3, 4]);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
  });

  it("respects Retry-After as a floor on the wait", async () => {
    const { runAgentLoop } = await import("./loop");
    attempts.push(err({ kind: "ratelimit", status: 429, retryAfterMs: 7_000 }), OK);
    const { ctx } = makeCtx();
    await runAgentLoop(ctx);
    expect(sleeps).toEqual([7_000]);
  });

  it.each([
    ["400", { kind: "http", status: 400 }],
    ["404", { kind: "http", status: 404 }],
    ["auth 401", { kind: "auth", status: 401 }],
    ["quota", { kind: "budget", status: 429 }],
  ] as const)("does not retry %s — fails the task at once", async (_n, e) => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    attempts.push(err(e as never));
    const onLlmPause = vi.fn(async () => {});
    const { ctx, emitted } = makeCtx({ onLlmPause });
    await runAgentLoop(ctx);
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);
    expect(emitted.some((m) => m.type === "chat-llm-retry")).toBe(false);
    expect(emitted.find((m) => m.type === "chat-error")).toBeDefined();
    expect(emitted.find((m) => m.type === "agent-done-task")).toMatchObject({ success: false });
    expect(onLlmPause).not.toHaveBeenCalled();
  });

  it("empty completion: plain retry first, then the nudge is appended (request only)", async () => {
    const { runAgentLoop } = await import("./loop");
    attempts.push(EMPTY, EMPTY, OK);
    const { ctx, emitted } = makeCtx();
    await runAgentLoop(ctx);
    expect(requests).toHaveLength(3);
    const lastText = (msgs: AgentMessage[]) => JSON.stringify(msgs[msgs.length - 1]);
    expect(lastText(requests[0])).not.toContain(EMPTY_RESPONSE_NUDGE);
    expect(lastText(requests[1])).not.toContain(EMPTY_RESPONSE_NUDGE); // first retry: no nudge
    expect(lastText(requests[2])).toContain(EMPTY_RESPONSE_NUDGE); // after the first retry
    // nudge merged into the trailing user turn — no two user turns in a row
    expect(requests[2].length).toBe(requests[0].length);
    expect(emitted.filter((m) => m.type === "chat-llm-retry").map((m) => m.reason)).toEqual(["empty", "empty"]);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
  });

  it("tells the panel how much partial output to drop when a stream fails mid-way", async () => {
    const { runAgentLoop } = await import("./loop");
    attempts.push(
      [{ type: "thinking-delta", text: "hmm" }, { type: "text-delta", text: "Partial" }, { type: "error", error: "reset", kind: "network" }],
      OK,
    );
    const { ctx, emitted } = makeCtx();
    await runAgentLoop(ctx);
    expect(emitted.find((m) => m.type === "chat-llm-retry")).toMatchObject({ discardText: 7, discardThinking: 3 });
  });

  it("all retries fail → pauses (no failure, history kept, agent-paused emitted)", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    for (let i = 0; i < 6; i++) attempts.push(err({ kind: "http", status: 502, error: "Bad gateway" }));
    const onLlmPause = vi.fn(async () => {});
    const { ctx, emitted, snapshots } = makeCtx({ onLlmPause });
    await runAgentLoop(ctx);
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(6); // 1 + 5 retries
    expect(emitted.filter((m) => m.type === "chat-llm-retry").map((m) => `${m.attempt}/${m.maxAttempts}`)).toEqual([
      "1/5", "2/5", "3/5", "4/5", "5/5",
    ]);
    // backoff grows and is capped at 30s
    expect(sleeps.every((ms) => ms <= 30_000)).toBe(true);
    expect(sleeps[4]).toBeGreaterThanOrEqual(15_000);
    expect(onLlmPause).toHaveBeenCalledWith({ error: "Bad gateway", kind: "http", reason: "llm-error" });
    expect(emitted.find((m) => m.type === "agent-paused")).toMatchObject({ error: "Bad gateway", stepCount: 0 });
    expect(emitted.some((m) => m.type === "agent-done-task")).toBe(false);
    expect(emitted.some((m) => m.type === "chat-error")).toBe(false);
    // resume seed: the full request history, not a tombstone
    const seed = snapshots[snapshots.length - 1] as { agentMessages: AgentMessage[]; stepIndex: number; taskActive: boolean };
    expect(seed.stepIndex).toBe(0);
    expect(seed.taskActive).toBe(false);
    expect(seed.agentMessages.length).toBeGreaterThanOrEqual(2);
    expect(seed.agentMessages[seed.agentMessages.length - 1].role).toBe("user");
  });

  it("a Retry-After beyond the inline limit pauses right away", async () => {
    const { runAgentLoop } = await import("./loop");
    attempts.push(err({ kind: "ratelimit", status: 429, retryAfterMs: 3_600_000 }));
    const onLlmPause = vi.fn(async () => {});
    const { ctx, emitted } = makeCtx({ onLlmPause });
    await runAgentLoop(ctx);
    expect(sleeps).toEqual([]);
    expect(onLlmPause).toHaveBeenCalledTimes(1);
    expect(emitted.some((m) => m.type === "agent-paused")).toBe(true);
  });

  it("without onLlmPause (headless runs) exhausted retries fail the task as before", async () => {
    const { runAgentLoop } = await import("./loop");
    for (let i = 0; i < 6; i++) attempts.push(EMPTY);
    const { ctx, emitted } = makeCtx();
    await runAgentLoop(ctx);
    expect(emitted.find((m) => m.type === "chat-error")?.error).toMatch(/empty response/);
    expect(emitted.find((m) => m.type === "agent-done-task")).toMatchObject({ success: false });
    expect(emitted.some((m) => m.type === "agent-paused")).toBe(false);
  });

  it("an idle stream is abandoned as a timeout and retried", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    vi.mocked(streamChat).mockImplementationOnce(async function* (_c: unknown, _m: unknown, signal?: AbortSignal) {
      await new Promise<void>((r) => signal!.addEventListener("abort", () => r(), { once: true }));
    } as never);
    attempts.push(OK);
    const { ctx, emitted } = makeCtx({ llmRetryPolicy: { idleTimeoutMs: 20 } });
    await runAgentLoop(ctx);
    expect(emitted.find((m) => m.type === "chat-llm-retry")).toMatchObject({ reason: "timeout" });
    expect(emitted.some((m) => m.type === "chat-done")).toBe(true);
  });

  it("Stop during the backoff ends the loop without another attempt", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    const ac = new AbortController();
    restoreSleep();
    restoreSleep = setRetrySleepForTests(async () => { ac.abort(); });
    attempts.push(err({ kind: "http", status: 500 }), OK);
    const { ctx, emitted } = makeCtx({ signal: ac.signal, onLlmPause: vi.fn() });
    await runAgentLoop(ctx);
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);
    expect(emitted.some((m) => m.type === "agent-paused")).toBe(false);
    expect(emitted.some((m) => m.type === "chat-done")).toBe(false);
  });
});
