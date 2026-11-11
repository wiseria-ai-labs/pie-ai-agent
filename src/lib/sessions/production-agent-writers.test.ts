// Issue #470: exercise the actual loop writers against a concurrent queue add.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import { _resetForTests } from "@/lib/idb/db";
import * as records from "@/lib/idb/sessions-store";
import { agentKey, createSession, setSessionAgent, setSessionMeta } from "./storage";
import { addPending } from "./pending-instructions";
import type { SessionAgentState } from "./types";
import { buildSessionAgentSnapshot, buildSessionAgentTombstone, runAgentLoop } from "@/lib/agent/loop";
import type { AgentLoopContext } from "@/lib/agent/loop";
import { streamChat } from "@/lib/model-router";

vi.mock("@/lib/model-router", async (original) => ({
  ...await original<typeof import("@/lib/model-router")>(),
  streamChat: vi.fn(),
}));
vi.mock("@/background/skill-source", async (original) => ({
  ...await original<typeof import("@/background/skill-source")>(),
  getEnabledSkillEntries: vi.fn(async () => []),
}));

const instruction = { chatMessageId: "queued", content: "queued mid-write", createdAt: 1 };
const pins = [
  { tabId: 1, origin: "https://example.com" },
  { tabId: 2, origin: "https://example.com" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Arm immediately before one production writer. In the atomic path, queue the
// instruction inside its IDB transaction; in the old get+set path, commit it
// after the read and before the stale set. Stop the writer after both commits,
// before the loop can drain the instruction on its next iteration.
function concurrentQueue(sessionId: string) {
  const key = agentKey(sessionId);
  const read = records.getSessionRecord;
  const update = records.updateSessionRecord;
  const batch = records.writeSessionBatch;
  const reached = deferred<SessionAgentState | undefined>();
  const proceed = deferred<void>();
  let armed = false;
  let legacySet = false;

  const updateSpy = vi.spyOn(records, "updateSessionRecord").mockImplementation((id, transform) => {
    if (!armed || id !== key) return update(id, transform);
    armed = false;
    let added: Promise<void> | undefined;
    return update(id, (current) => {
      const next = transform(current);
      added = addPending(sessionId, instruction);
      return next;
    }).then(async (result) => {
      await added;
      reached.resolve(await read<SessionAgentState>(key));
      await proceed.promise;
      return result;
    });
  });
  const readSpy = vi.spyOn(records, "getSessionRecord").mockImplementation((async (id: string) => {
    const stale = await read(id);
    if (armed && id === key) {
      armed = false;
      await addPending(sessionId, instruction);
      legacySet = true;
    }
    return stale;
  }) as typeof records.getSessionRecord);
  const batchSpy = vi.spyOn(records, "writeSessionBatch").mockImplementation(async (value) => {
    await batch(value);
    if (legacySet && value.records && key in value.records) {
      legacySet = false;
      reached.resolve(await read<SessionAgentState>(key));
      await proceed.promise;
    }
  });
  return {
    arm: () => { armed = true; },
    reached: reached.promise,
    release: () => proceed.resolve(),
    restore: () => { updateSpy.mockRestore(); readSpy.mockRestore(); batchSpy.mockRestore(); },
  };
}

beforeEach(async () => { await _resetForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("production loop agent writers", () => {
  it.each(["taskActive", "focus fallback", "contextUsage", "focus_tab"] as const)(
    "%s preserves a concurrently queued instruction", async (writer) => {
      const meta = await createSession();
      await setSessionMeta({ ...meta, pinnedTabs: pins });
      await setSessionAgent(meta.id, {
        agentMessages: [], pendingInstructions: [], stepIndex: 0,
        hasImageContent: false, currentFocusTabId: 1,
      });
      let race: ReturnType<typeof concurrentQueue>;
      let armedFallback = false;
      vi.spyOn(chrome.tabs, "get").mockImplementation(async (id) => {
        if (writer === "focus fallback" && id === 1) throw new Error("closed");
        if (writer === "focus fallback" && id === 2 && !armedFallback) {
          armedFallback = true;
          race.arm();
        }
        return { id, url: "https://example.com", title: "test" } as chrome.tabs.Tab;
      });
      race = concurrentQueue(meta.id);
      if (writer === "taskActive") race.arm();
      vi.mocked(streamChat).mockImplementation(async function* () {
        if (writer === "focus_tab") {
          yield { type: "tool-call-start", id: "focus", index: 0, name: "focus_tab" };
          yield { type: "tool-call-delta", index: 0, argsDelta: '{"tabId":2}' };
          yield { type: "tool-call-end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
          race.arm();
        } else {
          yield { type: "done", stopReason: "end", usage: { inputTokens: 10, outputTokens: 2 } };
          if (writer === "contextUsage") race.arm();
        }
      });
      const controller = new AbortController();
      const run = runAgentLoop({
        sessionId: meta.id, task: "test", emit: vi.fn(), signal: controller.signal,
        pinnedTabs: pins, initialFocusTabId: 1,
        modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "test", vision: false },
      });
      try {
        const state = await Promise.race([
          race.reached,
          run.then(() => { throw new Error(`loop exited before ${writer} write`); }),
        ]);
        expect(state?.pendingInstructions).toEqual([instruction]);
        if (writer === "taskActive") expect(state?.taskActive).toBe(true);
        if (writer === "contextUsage") expect(state?.contextUsage?.lastInputTokens).toBe(10);
        if (writer === "focus fallback" || writer === "focus_tab") expect(state?.currentFocusTabId).toBe(2);
      } finally {
        controller.abort();
        race.release();
        await run;
        race.restore();
      }
    },
  );
});

describe("SW snapshot callback", () => {
  it.each(["first snapshot", "seeded snapshot", "live snapshot", "tombstone"] as const)(
    "%s preserves a concurrently queued instruction", async (kind) => {
      // Import the real SW entry point and start a task through its port. Only
      // the loop itself is held, so the callback comes from handleChatStream.
      const event = () => ({ addListener: vi.fn() });
      Object.assign(chromeMock, {
        permissions: { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => false) },
        action: { onClicked: event() },
        debugger: { onDetach: event() },
        commands: { onCommand: event() },
      });
      Object.assign(chromeMock.tabs, { onRemoved: event(), onUpdated: event() });
      vi.stubGlobal("__PIE_EVAL__", false);
      const migrations = await import("@/lib/startup-migrations");
      const recovery = await import("@/background/session-recovery");
      const scheduler = await import("@/lib/schedules/scheduler");
      const panel = await import("@/background/panel-open");
      const bridge = await import("@/background/skill-migration");
      const log = await import("@/lib/log-buffer");
      vi.spyOn(migrations, "runStartupMigrations").mockResolvedValue();
      vi.spyOn(recovery, "detectAndMarkPaused").mockResolvedValue({ paused: 0, failed: 0, skippedDueToGuard: false });
      vi.spyOn(recovery, "markOrphanRunsInterrupted").mockResolvedValue({ interrupted: 0 });
      vi.spyOn(scheduler, "reconcileAlarms").mockResolvedValue();
      vi.spyOn(panel, "initPanelOpening").mockImplementation(() => {});
      vi.spyOn(bridge, "initBridgeAndMigrate").mockResolvedValue();
      vi.spyOn(log, "installLogCapture").mockImplementation(() => {});
      const selection = await import("@/lib/model-selection-resolver");
      const instances = await import("@/lib/instances");
      vi.spyOn(selection, "resolveSelection").mockResolvedValue({ instanceId: "i", model: "gpt-4o" });
      vi.spyOn(instances, "resolveModelConfig").mockResolvedValue({ provider: "openai", model: "gpt-4o", apiKey: "test" });
      const loop = await import("@/lib/agent/loop");
      const captured = deferred<AgentLoopContext>();
      const finish = deferred<void>();
      vi.spyOn(loop, "runAgentLoop").mockImplementation(async (ctx) => {
        captured.resolve(ctx);
        await finish.promise;
      });
      await import("@/background/index");
      const meta = await createSession();
      await setSessionMeta({ ...meta, pinMode: "user", pinnedTabs: pins });
      if (kind === "live snapshot" || kind === "tombstone") {
        await setSessionAgent(meta.id, {
          agentMessages: [{ role: "user", content: "old" }], pendingInstructions: [],
          stepIndex: 3, hasImageContent: false, taskActive: true,
        });
      }
      const port = chromeMock.runtime.connect({ name: `chat-stream-${meta.id}` });
      const connect = chromeMock.runtime.onConnect.addListener.mock.calls.at(-1)?.[0] as unknown as (port: unknown) => void;
      connect(port);
      port.__emit({ type: "chat-start", sessionId: meta.id, messages: [
        { role: "user", content: "previous" }, { role: "user", content: "task" },
      ] });
      let race: ReturnType<typeof concurrentQueue> | undefined;
      try {
        const ctx = await captured.promise;
        expect(ctx.onStepSnapshot).toBeDefined();
        if (kind === "first snapshot" || kind === "seeded snapshot") {
          await records.removeSessionRecord(agentKey(meta.id));
          expect(await records.getSessionRecord(agentKey(meta.id))).toBeUndefined();
        }
        const seeded = { ...instruction, chatMessageId: "first" };
        if (kind === "seeded snapshot") await addPending(meta.id, seeded);
        race = concurrentQueue(meta.id);
        race.arm();
        const snapshot = kind === "tombstone"
          ? buildSessionAgentTombstone()
          : buildSessionAgentSnapshot([{ role: "user", content: "new" }], 4);
        const write = ctx.onStepSnapshot!(snapshot);
        try {
          const state = await Promise.race([
            race.reached,
            write.then(() => { throw new Error("snapshot returned before the interleaving"); }),
          ]);
          expect(state?.pendingInstructions).toEqual(kind === "seeded snapshot" ? [seeded, instruction] : [instruction]);
          expect(state?.stepIndex).toBe(kind === "tombstone" ? 0 : 4);
          if (kind === "tombstone") expect(state?.taskActive).toBe(false);
        } finally {
          race.release();
          await write;
        }
      } finally {
        race?.restore();
        finish.resolve();
      }
    },
  );
});
