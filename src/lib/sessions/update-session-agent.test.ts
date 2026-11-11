// Issue #470 — lost-update race on the session AGENT record.
//
// Every agent-record writer used to do getSessionAgent → mutate →
// setSessionAgent across TWO IDB transactions. An instruction the user queued
// (addPending) between a writer's read and its write was written back stale
// and silently dropped. `updateSessionAgent(id, transform)` does the RMW in ONE
// readwrite transaction, so a queue op can no longer land "in between".

import { describe, expect, it, beforeEach, vi } from "vitest";
import "@/test/setup";
import { _resetForTests } from "@/lib/idb/db";
import * as sessionsStore from "@/lib/idb/sessions-store";
import {
  createSession,
  getSessionAgent,
  getSessionMeta,
  setSessionAgent,
  setSessionMeta,
  updateSessionAgent,
  setPendingConfirm,
  scrubPendingConfirm,
  setLastTaskSynth,
  clearLastTaskSynth,
  migrateLastTaskSynthFromMeta,
  recordSkillApproval,
} from "./storage";
import { addPending, cancelPending, drainPending } from "./pending-instructions";
import {
  buildSessionAgentSnapshot,
  buildSessionAgentTombstone,
  mergeContextUsage,
  mergeSessionAgentSnapshot,
  withContextUsage,
} from "@/lib/agent/loop";
import type { SessionAgentState } from "./types";

const Q = { chatMessageId: "q1", content: "queued mid-task", createdAt: 1 };

beforeEach(async () => {
  await _resetForTests();
});

function seed(): SessionAgentState {
  return {
    agentMessages: [{ role: "user", content: "task" }],
    pendingInstructions: [],
    stepIndex: 3,
    hasImageContent: false,
    pendingConfirm: { confirmationId: "c0", kind: "agent-tool", payload: null },
    lastTaskSynth: "<untrusted_prior_task_summary>x</untrusted_prior_task_summary>",
  };
}

const queued = async (id: string) =>
  ((await getSessionAgent(id))?.pendingInstructions ?? []).map((p) => p.chatMessageId);

async function queueDuringWrite<T>(sessionId: string, instruction: typeof Q, action: () => Promise<T>): Promise<T> {
  const original = sessionsStore.updateSessionRecord;
  let enqueue: Promise<void> | undefined;
  const spy = vi.spyOn(sessionsStore, "updateSessionRecord").mockImplementation((id, transform) =>
    original(id, (current) => {
      const next = transform(current);
      if (!enqueue) enqueue = addPending(sessionId, instruction);
      return next;
    }),
  );
  try {
    const result = await action();
    expect(enqueue).toBeDefined();
    await enqueue;
    return result;
  } finally {
    spy.mockRestore();
  }
}

describe("updateSessionAgent", () => {
  it("the legacy two-transaction get+set loses an instruction queued in between", async () => {
    await setSessionAgent("s", seed());
    const stale = await getSessionAgent("s"); // writer reads…
    await addPending("s", Q); // …user queues…
    await setSessionAgent("s", { ...stale!, stepIndex: 4 }); // …writer writes back stale
    expect(await queued("s")).toEqual([]); // the bug
  });

  it("a queue op issued between the writer's read and write is kept", async () => {
    await setSessionAgent("s", seed());
    let enqueue: Promise<void> | undefined;
    await updateSessionAgent("s", (cur) => {
      // Inside the writer's transaction: the queue op is issued now but can
      // only commit after this transaction, against the fresh record.
      enqueue = addPending("s", Q);
      return { ...cur!, stepIndex: 4 };
    });
    await enqueue;
    const after = await getSessionAgent("s");
    expect(after?.stepIndex).toBe(4);
    expect(await queued("s")).toEqual(["q1"]);
  });

  it("null / same reference skips the write", async () => {
    expect(await updateSessionAgent("missing", () => null)).toBe(false);
    await setSessionAgent("s", seed());
    expect(await updateSessionAgent("s", (cur) => cur)).toBe(false);
  });
});

// Every writer, run concurrently with a queue op. With the old get+set pairs
// one of the two effects was lost; now both must land.
const SNAP = buildSessionAgentSnapshot([{ role: "user", content: "step" }], 5);
const writers: Array<{
  name: string;
  run: (id: string) => Promise<unknown>;
  check: (s: SessionAgentState) => void;
}> = [
  {
    // SW makeStepSnapshotHandler + schedules/run.ts onStepSnapshot
    name: "step-snapshot merge",
    run: (id) => updateSessionAgent(id, (e) => mergeSessionAgentSnapshot(e, SNAP)),
    check: (s) => expect(s.stepIndex).toBe(5),
  },
  {
    name: "tombstone merge",
    run: (id) => updateSessionAgent(id, (e) => mergeSessionAgentSnapshot(e, buildSessionAgentTombstone())),
    check: (s) => expect(s.stepIndex).toBe(0),
  },
  {
    name: "loop contextUsage",
    run: (id) =>
      updateSessionAgent(id, (cur) =>
        withContextUsage(cur, mergeContextUsage(cur?.contextUsage, { inputTokens: 10, outputTokens: 2 })),
      ),
    check: (s) => expect(s.contextUsage?.lastInputTokens).toBe(10),
  },
  {
    name: "loop currentFocusTabId",
    run: (id) => updateSessionAgent(id, (cur) => (cur ? { ...cur, currentFocusTabId: 9 } : null)),
    check: (s) => expect(s.currentFocusTabId).toBe(9),
  },
  {
    name: "loop taskActive mark",
    run: (id) => updateSessionAgent(id, (cur) => ({ ...(cur ?? buildSessionAgentTombstone()), taskActive: true })),
    check: (s) => expect(s.taskActive).toBe(true),
  },
  {
    name: "setPendingConfirm",
    run: (id) => setPendingConfirm(id, { confirmationId: "c1", kind: "agent-tool", payload: null }),
    check: (s) => expect(s.pendingConfirm?.confirmationId).toBe("c1"),
  },
  {
    name: "scrubPendingConfirm",
    run: (id) => scrubPendingConfirm(id),
    check: (s) => expect(s.pendingConfirm).toBeUndefined(),
  },
  {
    name: "setLastTaskSynth",
    run: (id) => setLastTaskSynth(id, "new-synth"),
    check: (s) => expect(s.lastTaskSynth).toBe("new-synth"),
  },
  {
    name: "clearLastTaskSynth",
    run: (id) => clearLastTaskSynth(id),
    check: (s) => expect(s.lastTaskSynth).toBeUndefined(),
  },
  {
    name: "recordSkillApproval",
    run: (id) => recordSkillApproval(id, "skill-a"),
    check: (s) => expect(s.approvedSkillIds).toEqual(["skill-a"]),
  },
  {
    name: "cancelPending (other id)",
    run: (id) => cancelPending(id, "nope"),
    check: () => {},
  },
];

describe.each(writers)("writer: $name", ({ run, check }) => {
  it("keeps an instruction queued concurrently", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, seed());
    await queueDuringWrite(meta.id, Q, () => run(meta.id));
    const after = (await getSessionAgent(meta.id))!;
    check(after);
    expect(await queued(meta.id)).toEqual(["q1"]);
  });
});

describe("migrateLastTaskSynthFromMeta", () => {
  it("performs concurrent migrations only once", async () => {
    const meta = await createSession();
    await setSessionMeta({ ...meta, lastTaskSynth: "legacy" } as typeof meta);
    await setSessionAgent(meta.id, seed());
    const results = await Promise.all([
      migrateLastTaskSynthFromMeta(meta.id),
      migrateLastTaskSynthFromMeta(meta.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getSessionAgent(meta.id))?.lastTaskSynth).toBe("legacy");
    expect("lastTaskSynth" in ((await getSessionMeta(meta.id)) ?? {})).toBe(false);
  });

  it("moves the synth without clobbering a concurrently queued instruction", async () => {
    const meta = await createSession();
    await setSessionMeta({ ...meta, lastTaskSynth: "legacy" } as typeof meta);
    await setSessionAgent(meta.id, { ...seed(), lastTaskSynth: undefined });
    const original = sessionsStore.updateSessionRecordPair;
    let enqueue: Promise<void> | undefined;
    const spy = vi.spyOn(sessionsStore, "updateSessionRecordPair").mockImplementation((first, second, transform) =>
      original(first, second, (a, b) => {
        const next = transform(a, b);
        enqueue = addPending(meta.id, Q);
        return next;
      }),
    );
    try {
      expect(await migrateLastTaskSynthFromMeta(meta.id)).toBe(true);
      expect(enqueue).toBeDefined();
      await enqueue;
    } finally {
      spy.mockRestore();
    }
    expect((await getSessionAgent(meta.id))?.lastTaskSynth).toBe("legacy");
    expect(await queued(meta.id)).toEqual(["q1"]);
    expect("lastTaskSynth" in ((await getSessionMeta(meta.id)) ?? {})).toBe(false);
  });
});

describe("queue ops", () => {
  it("addPending seeds a record on a brand-new session (first step not yet snapshotted)", async () => {
    await addPending("fresh", Q);
    expect(await queued("fresh")).toEqual(["q1"]);
    // The first step snapshot (non-tombstone merge) keeps the seeded queue.
    await updateSessionAgent("fresh", (e) => mergeSessionAgentSnapshot(e, SNAP));
    expect(await queued("fresh")).toEqual(["q1"]);
    expect(await drainPending("fresh")).toHaveLength(1);
  });

  it("keeps the first instruction when the initial snapshot races with it", async () => {
    await Promise.all([
      addPending("fresh", Q),
      updateSessionAgent("fresh", (current) => mergeSessionAgentSnapshot(current, SNAP)),
    ]);
    expect(await queued("fresh")).toEqual(["q1"]);
    expect((await getSessionAgent("fresh"))?.stepIndex).toBe(5);
  });

  it("cancelling an existing instruction preserves a concurrent addition", async () => {
    await setSessionAgent("s", { ...seed(), pendingInstructions: [Q] });
    const next = { ...Q, chatMessageId: "q2" };
    expect(await queueDuringWrite("s", next, () => cancelPending("s", Q.chatMessageId))).toBe(true);
    expect(await queued("s")).toEqual(["q2"]);
  });

  it("draining the queue preserves an instruction added during the transaction", async () => {
    await setSessionAgent("s", { ...seed(), pendingInstructions: [Q] });
    const next = { ...Q, chatMessageId: "q2" };
    expect(await queueDuringWrite("s", next, () => drainPending("s"))).toEqual([Q]);
    expect(await queued("s")).toEqual(["q2"]);
  });

  it("interleaved add/drain delivers every message exactly once", async () => {
    await setSessionAgent("s", seed());
    const ids = Array.from({ length: 6 }, (_, i) => `m${i}`);
    const drained: string[] = [];
    await Promise.all(
      ids.flatMap((id) => [
        addPending("s", { ...Q, chatMessageId: id }),
        drainPending("s").then((d) => drained.push(...d.map((p) => p.chatMessageId))),
      ]),
    );
    drained.push(...(await drainPending("s")).map((p) => p.chatMessageId));
    expect(drained.sort()).toEqual(ids);
  });
});
