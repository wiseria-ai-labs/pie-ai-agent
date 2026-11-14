import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { getConfig } from "@/lib/idb/config-store";
import { getInboxEntry, listInbox, markAllInboxRead, markInboxRead, unreadInboxCount } from "./store";
import { addInboxEntry } from "./store";
import { MAX_INBOX_ENTRIES_PER_REF } from "./types";

beforeEach(async () => {
  await _resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inbox store", () => {
  it("appends entries newest-first and counts unread", async () => {
    await addInboxEntry({ source: "monitor", refId: "mon_1", kind: "triggered", title: "A", at: 1000 });
    await addInboxEntry({ source: "schedule", refId: "run_1", kind: "done", title: "B", at: 2000 });

    const all = await listInbox();
    expect(all.map((e) => e.title)).toEqual(["B", "A"]);
    expect(await unreadInboxCount()).toBe(2);
  });

  it("marks one entry read without touching the others", async () => {
    const a = await addInboxEntry({ source: "monitor", refId: "m", kind: "triggered", title: "A" });
    await addInboxEntry({ source: "monitor", refId: "m", kind: "triggered", title: "B" });
    await markInboxRead(a.id);
    expect((await getInboxEntry(a.id))?.read).toBe(true);
    expect(await unreadInboxCount()).toBe(1);
  });

  it("markAllInboxRead clears the unread dot", async () => {
    await addInboxEntry({ source: "monitor", refId: "m", kind: "triggered", title: "A" });
    await addInboxEntry({ source: "monitor", refId: "m", kind: "triggered", title: "B" });
    await markAllInboxRead();
    expect(await unreadInboxCount()).toBe(0);
  });

  it("keeps at most MAX_INBOX_ENTRIES_PER_REF per ref", async () => {
    for (let i = 0; i < MAX_INBOX_ENTRIES_PER_REF + 5; i++) {
      await addInboxEntry({ source: "monitor", refId: "mon_hot", kind: "triggered", title: `t${i}`, at: i });
    }
    const all = await listInbox();
    expect(all.filter((e) => e.refId === "mon_hot")).toHaveLength(MAX_INBOX_ENTRIES_PER_REF);
    // The newest survive.
    expect(all[0].title).toBe(`t${MAX_INBOX_ENTRIES_PER_REF + 4}`);
  });

  it("keeps idempotent ids for migration entries", async () => {
    const input = {
      id: "ibx_unread_run_1",
      source: "schedule" as const,
      refId: "run_1",
      kind: "needs_action" as const,
      title: "old",
    };
    await addInboxEntry(input);
    await addInboxEntry(input);
    expect((await listInbox()).filter((e) => e.id === input.id)).toHaveLength(1);
  });

  it("persists the structured data field used for localization", async () => {
    const e = await addInboxEntry({
      source: "monitor",
      refId: "m",
      kind: "triggered",
      title: "A",
      data: { from: "¥2,199", to: "¥1,999" },
    });
    expect((await getInboxEntry(e.id))?.data).toEqual({ from: "¥2,199", to: "¥1,999" });
  });

  it("does not wipe the migrated flag semantics — config stays untouched", async () => {
    expect(await getConfig("inbox_unread_migrated_v1")).toBeUndefined();
  });
});
