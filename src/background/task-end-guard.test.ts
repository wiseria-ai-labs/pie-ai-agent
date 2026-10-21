import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  admitInstruction,
  beginTask,
  currentGeneration,
  endTask,
  isSessionEnded,
  makeGuardedTaskEmit,
  markSessionEnded,
  reclaimLateInstructions,
  reopenSession,
  settleQueuedInstruction,
} from "./task-end-guard";
import type { PortMessageToPanel } from "@/types/messages";
import type { PendingInstruction } from "@/lib/sessions/types";

const SESSION_ID = "s1";

const instr = (id: string): PendingInstruction => ({
  chatMessageId: id,
  content: `msg ${id}`,
  createdAt: 1,
});

function makeDeps(queue: PendingInstruction[] = []) {
  const posted: PortMessageToPanel[] = [];
  return {
    posted,
    deps: {
      post: (m: PortMessageToPanel) => {
        posted.push(m);
      },
      drainPending: async () => {
        const drained = [...queue];
        queue.length = 0;
        return drained;
      },
    },
  };
}

beforeEach(() => {
  reopenSession(SESSION_ID);
});

describe("session end state", () => {
  it("starts open and closes on mark", () => {
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    markSessionEnded(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(true);
  });

  it("reopens for the next task", () => {
    markSessionEnded(SESSION_ID);
    reopenSession(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(false);
  });
});

describe("makeGuardedTaskEmit", () => {
  it("forwards every message to the panel", () => {
    const { posted, deps } = makeDeps();
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen);
    emit({ type: "chat-chunk", text: "hi", sessionId: SESSION_ID });
    expect(posted.map((m) => m.type)).toEqual(["chat-chunk"]);
    // A chunk is not a terminal message — the queue stays open.
    expect(isSessionEnded(SESSION_ID)).toBe(false);
  });

  it("closes the queue on chat-done", () => {
    const { posted, deps } = makeDeps();
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen);
    emit({ type: "chat-done", sessionId: SESSION_ID });
    expect(isSessionEnded(SESSION_ID)).toBe(true);
    expect(posted.map((m) => m.type)).toEqual(["chat-done"]);
  });

  it("closes the queue on agent-done-task", () => {
    const { deps } = makeDeps();
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen);
    emit({
      type: "agent-done-task",
      success: true,
      summary: "done",
      stepCount: 3,
      sessionId: SESSION_ID,
    });
    expect(isSessionEnded(SESSION_ID)).toBe(true);
  });

  it("reclaims an instruction that raced past the loop's last queue check", async () => {
    const queue = [instr("late-1")];
    const { posted, deps } = makeDeps(queue);
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen);

    // The instruction is queued AFTER the loop's final check but BEFORE the
    // final emit.
    emit({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    expect(posted[1]).toMatchObject({
      type: "chat-instruction-rejected",
      sessionId: SESSION_ID,
      chatMessageId: "late-1",
      reason: "not-streaming",
    });
    // The queue is empty — the instruction was taken out, not left to rot.
    expect(queue).toHaveLength(0);
  });

  it("posts ONE rejection when several instructions raced in", async () => {
    const queue = [instr("late-1"), instr("late-2"), instr("late-3")];
    const { posted, deps } = makeDeps(queue);
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen);

    emit({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    // The panel's fallback re-sends the whole conversation, so one rejection
    // covers all three — more would start several tasks.
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });

  it("posts no rejection when the queue was already drained", async () => {
    const { posted, deps } = makeDeps([]);
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen);
    emit({ type: "chat-done", sessionId: SESSION_ID });
    await new Promise((r) => setTimeout(r, 5));
    expect(posted.map((m) => m.type)).toEqual(["chat-done"]);
  });
});

describe("reclaimLateInstructions", () => {
  it("does nothing when the queue is empty", async () => {
    const { posted, deps } = makeDeps([]);
    await reclaimLateInstructions(deps, SESSION_ID);
    expect(posted).toHaveLength(0);
  });

  it("hands the instruction back to the panel", async () => {
    const { posted, deps } = makeDeps([instr("x")]);
    await reclaimLateInstructions(deps, SESSION_ID);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "chat-instruction-rejected",
      chatMessageId: "x",
    });
  });
});

describe("task generations", () => {
  it("beginTask bumps the generation and reopens the queue", () => {
    beginTask(SESSION_ID);
    markSessionEnded(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(true);
    const gen = beginTask(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(currentGeneration(SESSION_ID)).toBe(gen);
  });

  it("a superseded task's terminal emit does not close the new task's queue", async () => {
    const queue = [instr("for-the-new-task")];
    const { posted, deps } = makeDeps(queue);

    // Task A starts…
    const genA = beginTask(SESSION_ID);
    const emitA = makeGuardedTaskEmit(deps, SESSION_ID, genA);

    // …the panel starts task B before A winds down.
    const genB = beginTask(SESSION_ID);
    const emitB = makeGuardedTaskEmit(deps, SESSION_ID, genB);

    // A's late terminal emit (the abort path emits from the loop's finally,
    // after the new task already started) must not touch B's queue.
    emitA({ type: "agent-done-task", success: false, summary: "aborted", stepCount: 2, sessionId: SESSION_ID });
    await new Promise((r) => setTimeout(r, 5));

    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
    expect(queue).toHaveLength(1); // B's instruction is untouched

    // B's own terminal emit does close the queue.
    emitB({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(isSessionEnded(SESSION_ID)).toBe(true));
  });

  it("endTask is a no-op for a stale generation", async () => {
    const { posted, deps } = makeDeps([instr("x")]);
    const stale = currentGeneration(SESSION_ID);
    beginTask(SESSION_ID); // a newer task takes over
    endTask(deps, SESSION_ID, stale);
    await new Promise((r) => setTimeout(r, 5));
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("a task whose dispatch generation is stale cannot close the new task's queue", async () => {
    const queue = [instr("for-the-new-task")];
    const { posted, deps } = makeDeps(queue);

    // Task A is dispatched (generation 1)…
    const genA = beginTask(SESSION_ID);
    // …but before A's loop actually starts, task B is dispatched (generation 2).
    const genB = beginTask(SESSION_ID);
    // A's emit wrapper is built with A's generation, not the current one.
    const emitA = makeGuardedTaskEmit(deps, SESSION_ID, genA);
    const emitB = makeGuardedTaskEmit(deps, SESSION_ID, genB);

    emitA({ type: "agent-done-task", success: false, summary: "aborted", stepCount: 1, sessionId: SESSION_ID });
    await new Promise((r) => setTimeout(r, 5));

    expect(genA).not.toBe(genB);
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(queue).toHaveLength(1);
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
  });
});

describe("user abort (P-MTI-9: the queue survives an abort)", () => {
  it("an aborted task's terminal emit neither closes nor reclaims the queue", async () => {
    // Regression: reclaiming on abort posted chat-instruction-rejected, and
    // the panel answered with a chat-start — the agent restarted on its own
    // right after the user pressed Stop.
    const queue = [instr("queued-before-stop")];
    const { posted, deps } = makeDeps(queue);
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen, () => true);

    emit({ type: "agent-done-task", success: false, summary: "aborted", stepCount: 2, sessionId: SESSION_ID });
    await new Promise((r) => setTimeout(r, 5));

    expect(posted.map((m) => m.type)).toEqual(["agent-done-task"]);
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(queue).toHaveLength(1); // carried over into the next chat-start
  });

  it("a non-aborted task still reclaims", async () => {
    const queue = [instr("late")];
    const { posted, deps } = makeDeps(queue);
    const gen = beginTask(SESSION_ID);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID, gen, () => false);
    emit({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(queue).toHaveLength(0);
  });
});

describe("one fallback rejection per ended task", () => {
  function settleDeps(queue: PendingInstruction[]) {
    const posted: PortMessageToPanel[] = [];
    return {
      posted,
      deps: {
        post: (m: PortMessageToPanel) => {
          posted.push(m);
        },
        cancelPending: async (_sid: string, id: string) => {
          const i = queue.findIndex((p) => p.chatMessageId === id);
          if (i < 0) return false;
          queue.splice(i, 1);
          return true;
        },
      },
    };
  }

  it("reclaim + a late add whose write lands after the drain → ONE rejection", async () => {
    // Regression: A sits in the queue at task end (reclaimed → rejection 1);
    // B's addPending commits after the reclaim drain → it was rejected too,
    // and the panel's second chat-start aborted the first fallback task.
    const queue = [instr("A")];
    const { posted, deps } = makeDeps(queue);
    const gen = beginTask(SESSION_ID);
    const addGeneration = currentGeneration(SESSION_ID); // B accepted mid-task
    makeGuardedTaskEmit(deps, SESSION_ID, gen)({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    queue.push(instr("B")); // B's write lands now
    const s = settleDeps(queue);
    const stillQueued = await settleQueuedInstruction(s.deps, SESSION_ID, "B", addGeneration);

    expect(stillQueued).toBe(false);
    expect(queue).toHaveLength(0); // not stranded
    expect(s.posted).toHaveLength(0); // no second rejection
  });

  it("two instruction-adds arriving after the task ended → ONE rejection", () => {
    beginTask(SESSION_ID);
    markSessionEnded(SESSION_ID);
    expect(admitInstruction(SESSION_ID, true)).toBe("reject");
    expect(admitInstruction(SESSION_ID, true)).toBe("drop");
    expect(admitInstruction(SESSION_ID, false)).toBe("drop");
  });

  it("a late add after the reclaim already rejected is dropped, not rejected again", async () => {
    const { posted, deps } = makeDeps([instr("A")]);
    const gen = beginTask(SESSION_ID);
    endTask(deps, SESSION_ID, gen);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(admitInstruction(SESSION_ID, true)).toBe("drop");
  });

  it("the next task reopens the queue and resets the rejection budget", () => {
    beginTask(SESSION_ID);
    markSessionEnded(SESSION_ID);
    expect(admitInstruction(SESSION_ID, true)).toBe("reject");
    beginTask(SESSION_ID);
    expect(admitInstruction(SESSION_ID, true)).toBe("accept");
    markSessionEnded(SESSION_ID);
    expect(admitInstruction(SESSION_ID, false)).toBe("reject");
  });

  it("not in flight and not ended → reject every time (SW-restart fallback unchanged)", () => {
    beginTask(SESSION_ID);
    expect(admitInstruction(SESSION_ID, false)).toBe("reject");
    expect(admitInstruction(SESSION_ID, false)).toBe("reject");
  });

  it("first late add whose write lands after the end, with no reclaim rejection yet → rejected", async () => {
    const queue: PendingInstruction[] = [];
    const gen = beginTask(SESSION_ID);
    markSessionEnded(SESSION_ID);
    void gen;
    queue.push(instr("B"));
    const s = settleDeps(queue);
    expect(await settleQueuedInstruction(s.deps, SESSION_ID, "B", currentGeneration(SESSION_ID))).toBe(false);
    expect(queue).toHaveLength(0);
    expect(s.posted).toEqual([
      { type: "chat-instruction-rejected", sessionId: SESSION_ID, chatMessageId: "B", reason: "not-streaming" },
    ]);
  });

  it("a new task began while the write was in flight → pulled out silently (no duplicate delivery)", async () => {
    // The panel's fallback chat-start (which already contains B) overtook
    // B's queue write; leaving B queued would hand it to the new task twice.
    const queue: PendingInstruction[] = [];
    const addGeneration = beginTask(SESSION_ID);
    markSessionEnded(SESSION_ID);
    beginTask(SESSION_ID); // fallback chat-start
    queue.push(instr("B"));
    const s = settleDeps(queue);
    expect(await settleQueuedInstruction(s.deps, SESSION_ID, "B", addGeneration)).toBe(false);
    expect(queue).toHaveLength(0);
    expect(s.posted).toHaveLength(0);
  });

  it("running task, same generation → stays queued", async () => {
    const queue = [instr("B")];
    const gen = beginTask(SESSION_ID);
    const s = settleDeps(queue);
    expect(await settleQueuedInstruction(s.deps, SESSION_ID, "B", gen)).toBe(true);
    expect(queue).toHaveLength(1);
  });
});
