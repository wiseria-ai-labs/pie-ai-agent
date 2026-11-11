// Issue #470 — SW guard for the final-emit → teardown window.
import { describe, expect, it, beforeEach, vi } from "vitest";
import * as sessionsStore from "@/lib/idb/sessions-store";
import "@/test/setup";
import { _resetForTests } from "@/lib/idb/db";
import { addPending, cancelPending, drainPending } from "@/lib/sessions/pending-instructions";
import { mergeCarryoverIntoMessages } from "@/lib/agent/loop-drain";
import { getSessionAgent } from "@/lib/sessions/storage";
import {
  __resetTaskEndGuard,
  beginTask,
  claimRejection,
  isCurrentTask,
  isTaskEnded,
  makeTaskEmit,
  updateCurrentTaskAgent,
  waitForTaskReclaim,
} from "./task-end-guard";

const SID = "s-guard";
const Q = (id: string) => ({ chatMessageId: id, content: id, createdAt: 1 });

beforeEach(async () => {
  await _resetForTests();
  __resetTaskEndGuard();
});

function fakePort() {
  const posted: Array<{ type: string; chatMessageId?: string }> = [];
  return { posted, port: { postMessage: (m: unknown) => void posted.push(m as never) } };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("task-end guard", () => {
  it("instruction that raced past the loop's final check is reclaimed with ONE rejection", async () => {
    const { posted, port } = fakePort();
    const gen = beginTask(SID);
    await addPending(SID, Q("a"));
    await addPending(SID, Q("b"));
    makeTaskEmit(port, SID, gen, new AbortController().signal)({ type: "chat-done", sessionId: SID });
    await flush();

    expect(isTaskEnded(SID)).toBe(true);
    expect((await getSessionAgent(SID))?.pendingInstructions).toEqual([]);
    const rejections = posted.filter((m) => m.type === "chat-instruction-rejected");
    expect(rejections).toHaveLength(1);
    // A later instruction-add in the same window is not rejected a second time.
    expect(claimRejection(SID)).toBe(false);
  });

  it("terminal emit with empty queue latches ended; first late add gets the single rejection", async () => {
    const { posted, port } = fakePort();
    const gen = beginTask(SID);
    makeTaskEmit(port, SID, gen, new AbortController().signal)({ type: "agent-done-task", sessionId: SID, success: true, summary: "", stepCount: 1 });
    await flush();
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
    expect(isTaskEnded(SID)).toBe(true);
    expect(claimRejection(SID)).toBe(true);
    expect(claimRejection(SID)).toBe(false);
  });

  it("a superseded task's late terminal emit does not close the new task's queue", async () => {
    const { posted, port } = fakePort();
    const oldGen = beginTask(SID);
    const oldEmit = makeTaskEmit(port, SID, oldGen, new AbortController().signal);
    const newGen = beginTask(SID); // panel started a new task
    await addPending(SID, Q("for-new-task"));

    oldEmit({ type: "agent-done-task", sessionId: SID, success: false, summary: "aborted", stepCount: 1 });
    await flush();

    expect(isCurrentTask(SID, oldGen)).toBe(false);
    expect(isCurrentTask(SID, newGen)).toBe(true);
    expect(isTaskEnded(SID)).toBe(false);
    expect((await getSessionAgent(SID))?.pendingInstructions.map((p) => p.chatMessageId)).toEqual(["for-new-task"]);
    expect(posted).toEqual([]);
  });

  it("does not apply an old snapshot after a new task takes ownership", async () => {
    const oldGen = beginTask(SID);
    await addPending(SID, Q("new-task-instruction"));
    const oldWrite = updateCurrentTaskAgent(SID, oldGen, (current) => ({
      ...current!, taskActive: false, stepIndex: 0,
    }));
    beginTask(SID);
    expect(await oldWrite).toBe(false);
    expect((await getSessionAgent(SID))?.pendingInstructions).toEqual([Q("new-task-instruction")]);
  });

  it("restores reclaimed instructions before a replacement task reads the queue", async () => {
    const { posted, port } = fakePort();
    const gen = beginTask(SID);
    await addPending(SID, Q("a"));
    const original = sessionsStore.updateSessionRecord;
    let replaced = false;
    const spy = vi.spyOn(sessionsStore, "updateSessionRecord").mockImplementation((id, transform) =>
      original(id, (current) => {
        const next = transform(current);
        if (!replaced) {
          replaced = true;
          beginTask(SID);
        }
        return next;
      }),
    );
    try {
      makeTaskEmit(port, SID, gen, new AbortController().signal)({ type: "chat-done", sessionId: SID });
      await waitForTaskReclaim(SID);
    } finally {
      spy.mockRestore();
    }
    expect(replaced).toBe(true);
    expect((await getSessionAgent(SID))?.pendingInstructions).toEqual([Q("a")]);
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
  });

  it("does not restore a cancellation between reclaim and replacement task", async () => {
    const { posted, port } = fakePort();
    const gen = beginTask(SID);
    await addPending(SID, { ...Q("a"), content: "cancelled instruction" });
    await addPending(SID, { ...Q("b"), content: "retained instruction" });
    const put = IDBObjectStore.prototype.put;
    let cancellation: Promise<boolean> | undefined;
    let addition: Promise<void> | undefined;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (!cancellation) {
        cancellation = cancelPending(SID, "a");
        beginTask(SID);
        addition = addPending(SID, { ...Q("c"), content: "new instruction" });
      }
      return request;
    });
    try {
      makeTaskEmit(port, SID, gen, new AbortController().signal)({ type: "chat-done", sessionId: SID });
      await waitForTaskReclaim(SID);
      expect(cancellation).toBeDefined();
      expect(addition).toBeDefined();
      await Promise.all([cancellation, addition]);
    } finally {
      spy.mockRestore();
    }
    expect((await getSessionAgent(SID))?.pendingInstructions.map((item) => item.chatMessageId)).toEqual(["b", "c"]);
    const input = mergeCarryoverIntoMessages([{ role: "user", content: "new task" }], await drainPending(SID));
    expect(input[0]!.content).toContain("new task");
    expect(input[0]!.content).toContain("retained instruction");
    expect(input[0]!.content).toContain("new instruction");
    expect(input[0]!.content).not.toContain("cancelled instruction");
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
  });

  it("rejects an uncancelled sibling when a reclaimed instruction is cancelled", async () => {
    const { posted, port } = fakePort();
    const gen = beginTask(SID);
    await addPending(SID, Q("a"));
    await addPending(SID, Q("b"));
    const put = IDBObjectStore.prototype.put;
    let cancellation: Promise<boolean> | undefined;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (!cancellation) cancellation = cancelPending(SID, "a");
      return request;
    });
    try {
      makeTaskEmit(port, SID, gen, new AbortController().signal)({ type: "chat-done", sessionId: SID });
      await waitForTaskReclaim(SID);
      expect(cancellation).toBeDefined();
      await cancellation;
    } finally {
      spy.mockRestore();
    }
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toEqual([
      expect.objectContaining({ chatMessageId: "b" }),
    ]);
    expect((await getSessionAgent(SID))?.pendingInstructions).toEqual([]);
  });

  it("abort keeps the queue for chat-start carryover", async () => {
    const { posted, port } = fakePort();
    const gen = beginTask(SID);
    await addPending(SID, Q("a"));
    const ac = new AbortController();
    ac.abort();
    makeTaskEmit(port, SID, gen, ac.signal)({ type: "agent-done-task", sessionId: SID, success: false, summary: "", stepCount: 1 });
    await flush();
    expect((await getSessionAgent(SID))?.pendingInstructions).toHaveLength(1);
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
  });

  it("a new task reopens the queue", async () => {
    const gen = beginTask(SID);
    const { port } = fakePort();
    makeTaskEmit(port, SID, gen, new AbortController().signal)({ type: "chat-done", sessionId: SID });
    expect(isTaskEnded(SID)).toBe(true);
    beginTask(SID);
    expect(isTaskEnded(SID)).toBe(false);
    await waitForTaskReclaim(SID);
  });
});
