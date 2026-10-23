import { describe, it, expect, beforeEach, vi } from "vitest";
import { addPending } from "./pending-instructions";
import {
  getSessionAgent,
  getSessionMeta,
  setLastTaskSynth,
  setPendingConfirm,
  setSessionAgent,
  setSessionMeta,
  scrubPendingConfirm,
  clearLastTaskSynth,
  migrateLastTaskSynthFromMeta,
  updateSessionAgent,
} from "./storage";
import type { SessionMeta } from "./types";
import { _resetForTests } from "@/lib/idb/db";

// Issue #34 follow-up — the mid-task instruction queue lives on the session's
// agent record, and that record has MANY writers (step snapshots, confirm
// cards, task synth, context usage, focus tracking). A writer that does a
// plain get → set writes back a stale copy of the record and silently drops
// an instruction the user queued in between.
//
// The fix is `updateSessionAgent()`: read-modify-write inside ONE IDB
// readwrite transaction, so the queue is never clobbered. These tests pin the
// invariant for every remaining writer.
//
// ── The deterministic race ───────────────────────────────────────────────────
//
// The lost update needs the writer to READ the record BEFORE the instruction
// lands and WRITE it back AFTER. Sequencing that with plain `await`s is
// timing-dependent, so the agent-record read is gated: `getSessionRecord`
// captures the current value, then parks on a promise the test releases only
// after `addPending` has committed. The writer therefore resumes with a
// guaranteed stale copy — exactly the interleaving that used to drop the
// message.
//
// Only the agent record is gated: the meta record is not part of the queue,
// and gating it would shift the interleaving away from the race.
//
// A writer built on `updateSessionAgent` never calls `getSessionRecord` (it
// reads inside its own transaction), so it is immune by construction: the
// gate is simply never awaited.

let gate: Promise<void> | null = null;
let releaseGate: (() => void) | null = null;
let armed = false;
let signalParked: (() => void) | null = null;

vi.mock("@/lib/idb/sessions-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/idb/sessions-store")>();
  return {
    ...actual,
    getSessionRecord: async (id: string) => {
      const value = await actual.getSessionRecord(id);
      if (armed && gate && id.endsWith(":agent")) {
        signalParked?.();
        await gate;
      }
      return value;
    },
  };
});

const SESSION_ID = "s1";
const INSTR = { chatMessageId: "m1", content: "queued mid-task", createdAt: 1 };

async function seedAgent() {
  await setSessionAgent(SESSION_ID, {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 1,
    hasImageContent: false,
  });
}

beforeEach(async () => {
  armed = false;
  gate = null;
  releaseGate = null;
  await _resetForTests();
  await seedAgent();
});

async function pendingIds(): Promise<string[] | undefined> {
  const state = await getSessionAgent(SESSION_ID);
  return state?.pendingInstructions.map((p) => p.chatMessageId);
}

/**
 * Run `write` so that its internal read parks, queue an instruction, then
 * release the read. `write` resumes with the stale copy it read.
 *
 * A writer built on `updateSessionAgent` never parks (it reads inside its
 * own transaction) — the race below simply resolves immediately for it.
 */
async function writeWithStaleRead(write: () => Promise<void>): Promise<void> {
  gate = new Promise<void>((res) => {
    releaseGate = res;
  });
  let resolveParked: () => void = () => {};
  const parked = new Promise<void>((res) => {
    resolveParked = res;
  });
  signalParked = resolveParked;
  armed = true;
  const pending = write();
  // Wait until the writer has parked on its stale read (or has finished,
  // in which case there is no stale read to race with).
  await Promise.race([parked, pending.then(() => undefined)]);
  await addPending(SESSION_ID, INSTR);
  releaseGate?.();
  await pending;
  armed = false;
  gate = null;
  releaseGate = null;
  signalParked = null;
}

describe("agent-record writers keep a concurrently queued instruction", () => {
  const writers: Array<[string, () => Promise<void>]> = [
    [
      "setPendingConfirm",
      () =>
        setPendingConfirm(SESSION_ID, {
          confirmationId: "c1",
          kind: "agent-tool",
          payload: {},
        }),
    ],
    [
      "scrubPendingConfirm",
      async () => {
        await setPendingConfirm(SESSION_ID, {
          confirmationId: "c1",
          kind: "agent-tool",
          payload: {},
        });
        await scrubPendingConfirm(SESSION_ID);
      },
    ],
    ["setLastTaskSynth", () => setLastTaskSynth(SESSION_ID, "<synth>x</synth>")],
    [
      "clearLastTaskSynth",
      async () => {
        await setLastTaskSynth(SESSION_ID, "<synth>x</synth>");
        await clearLastTaskSynth(SESSION_ID);
      },
    ],
  ];

  for (const [name, write] of writers) {
    it(`${name} — instruction queued while the writer holds a stale read survives`, async () => {
      await writeWithStaleRead(write);
      expect(await pendingIds()).toEqual(["m1"]);
    });

    it(`${name} — instruction queued before the write survives`, async () => {
      await addPending(SESSION_ID, INSTR);
      await write();
      expect(await pendingIds()).toEqual(["m1"]);
    });
  }

  it("migrateLastTaskSynthFromMeta keeps a concurrently queued instruction", async () => {
    // A pre-AD1 meta still carrying the synth field.
    await setSessionMeta({
      id: SESSION_ID,
      createdAt: 1700000000000,
      lastAccessedAt: 1700000000000,
      status: "active",
      messages: [],
      lastTaskSynth: "<synth>old</synth>",
    } as SessionMeta & { lastTaskSynth?: string });
    await seedAgent();

    await writeWithStaleRead(async () => {
      await migrateLastTaskSynthFromMeta(SESSION_ID);
    });

    expect(await pendingIds()).toEqual(["m1"]);
    // The migration itself still does its job.
    const agent = await getSessionAgent(SESSION_ID);
    expect(agent?.lastTaskSynth).toBe("<synth>old</synth>");
    const stripped = (await getSessionMeta(SESSION_ID)) as unknown as Record<
      string,
      unknown
    >;
    expect(stripped.lastTaskSynth).toBeUndefined();
  });
});

describe("updateSessionAgent — atomic read-modify-write", () => {
  it("two concurrent writers both land (no lost update)", async () => {
    await Promise.all([
      updateSessionAgent(SESSION_ID, (cur) =>
        cur ? { ...cur, pendingInstructions: [...cur.pendingInstructions, INSTR] } : null,
      ),
      updateSessionAgent(SESSION_ID, (cur) =>
        cur ? { ...cur, currentFocusTabId: 42 } : null,
      ),
    ]);
    const state = await getSessionAgent(SESSION_ID);
    expect(state?.pendingInstructions.map((p) => p.chatMessageId)).toEqual(["m1"]);
    expect(state?.currentFocusTabId).toBe(42);
  });

  it("returns false and writes nothing when the transform returns null", async () => {
    const wrote = await updateSessionAgent(SESSION_ID, () => null);
    expect(wrote).toBe(false);
    expect((await getSessionAgent(SESSION_ID))?.pendingInstructions).toEqual([]);
  });
});
