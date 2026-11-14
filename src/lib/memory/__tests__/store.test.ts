import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests, tx, STORES } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import {
  applyMemoryOps,
  clearAllMemory,
  deleteMemoryEntries,
  expireStaleRecent,
  exportMemory,
  getMemoryEntry,
  getMemoryProfile,
  getMemorySettings,
  getMemorySnapshot,
  getMemoryState,
  listMemoryEntries,
  recordMemoryUsage,
  rememberEntry,
  restoreMemorySnapshot,
  saveMemorySnapshot,
  setMemoryProfileText,
  setMemorySettings,
  undoMemoryEvent,
  updateMemoryEntry,
  MEMORY_PROFILE_ID,
} from "../store";
import { MEMORY_RECENT_TTL_MS, type MemoryEntry } from "../types";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

/** 直接读原始记录（跳过解密），用来验证「地址类条目落盘是密文」。 */
async function rawEntry(id: string): Promise<MemoryEntry | undefined> {
  return tx<MemoryEntry | undefined>(STORES.memory, "readonly", (s) => s.get(id));
}

describe("rememberEntry", () => {
  it("writes immediately, pins, and returns an undoable event", async () => {
    const res = await rememberEntry({
      kind: "preference",
      title: "高铁坐一等座",
      body: "公司报销",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [e] = await listMemoryEntries();
    expect(e!.title).toBe("高铁坐一等座");
    expect(e!.pinned).toBe(true);
    expect(e!.origin).toBe("explicit");

    const undone = await undoMemoryEvent(res.event.eventId);
    expect(undone.ok).toBe(true);
    expect(await listMemoryEntries()).toHaveLength(0);
  });

  it("updates the same entry instead of duplicating, and undo restores the old body", async () => {
    const first = await rememberEntry({
      kind: "preference",
      title: "高铁坐一等座",
      body: "公司报销",
      now: NOW,
    });
    expect(first.ok).toBe(true);
    const second = await rememberEntry({
      kind: "preference",
      title: "高铁坐一等座",
      body: "公司报销，上午出发",
      now: NOW + 1000,
    });
    expect(second.ok).toBe(true);
    expect(await listMemoryEntries()).toHaveLength(1);

    if (!second.ok) return;
    await undoMemoryEvent(second.event.eventId);
    const [e] = await listMemoryEntries();
    expect(e!.body).toBe("公司报销");
  });

  it("refuses credentials", async () => {
    const res = await rememberEntry({
      kind: "about",
      title: "银行卡",
      body: "6222021234567890123",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(await listMemoryEntries()).toHaveLength(0);
  });
});

describe("contact entries are encrypted at rest", () => {
  it("stores ciphertext, decrypts on read, and masks nothing else", async () => {
    const res = await rememberEntry({
      kind: "contact",
      title: "家庭住址",
      body: "杭州市西湖区文三路 100 号",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const raw = await rawEntry(res.id);
    expect(raw!.encrypted).toBe(true);
    expect(raw!.body).not.toContain("文三路");
    expect(raw!.title).not.toContain("家庭住址");

    const [decrypted] = await listMemoryEntries();
    expect(decrypted!.body).toContain("文三路");
    expect(decrypted!.encrypted).toBe(true);

    const got = await getMemoryEntry(res.id);
    expect(got!.title).toBe("家庭住址");
  });

  it("export contains the plaintext (user-initiated export)", async () => {
    await rememberEntry({ kind: "contact", title: "手机", body: "13800000000", now: NOW });
    const data = await exportMemory(NOW);
    expect(data.entries[0]!.body).toContain("13800000000");
  });

  it("never overwrites an undecryptable entry with empty text", async () => {
    const res = await rememberEntry({ kind: "contact", title: "住址", body: "西湖区", now: NOW });
    if (!res.ok) throw new Error("setup");
    // 模拟密钥变了：密文解不开
    const raw = (await rawEntry(res.id))!;
    await tx(STORES.memory, "readwrite", (s) => s.put({ ...raw, body: "!!not-ciphertext!!" }));

    const [broken] = await listMemoryEntries();
    expect(broken!.decryptFailed).toBe(true);
    expect(broken!.title).toBe("");

    // 普通整理（空操作）不应把它写回成空文本
    await applyMemoryOps([], { origin: "consolidated", now: NOW + 1 });
    expect((await rawEntry(res.id))!.body).toBe("!!not-ciphertext!!");
  });

  it("undo of a deleted contact entry keeps it encrypted at rest", async () => {
    const res = await rememberEntry({
      kind: "contact",
      title: "家庭住址",
      body: "杭州市西湖区文三路 100 号",
      now: NOW,
    });
    if (!res.ok) throw new Error("setup");
    const del = await deleteMemoryEntries([res.id]);
    expect(del.count).toBe(1);
    expect(await undoMemoryEvent(del.eventId!)).toMatchObject({ ok: true, kind: "deleted" });

    const raw = await rawEntry(res.id);
    expect(raw!.encrypted).toBe(true);
    expect(raw!.body).not.toContain("文三路");
    const [decrypted] = await listMemoryEntries();
    expect(decrypted!.body).toContain("文三路");
  });

  it("undo of an overwritten contact entry restores the previous ciphertext", async () => {
    const first = await rememberEntry({ kind: "contact", title: "住址", body: "西湖区", now: NOW });
    if (!first.ok) throw new Error("setup");
    const second = await rememberEntry({ kind: "contact", title: "住址", body: "滨江区", now: NOW + 1 });
    if (!second.ok) throw new Error("setup");
    expect((await listMemoryEntries())[0]!.body).toBe("滨江区");
    await undoMemoryEvent(second.event.eventId);
    const [e] = await listMemoryEntries();
    expect(e!.body).toBe("西湖区");
    expect((await rawEntry(e!.id))!.body).not.toContain("西湖区");
  });
});

describe("applyMemoryOps", () => {
  it("applies a batch and advances the watermark in one go", async () => {
    const plan = await applyMemoryOps(
      [
        { op: "add", kind: "about", title: "住在杭州", body: "西湖区" },
        { op: "profile", text: "用户住在杭州。" },
      ],
      {
        origin: "consolidated",
        now: NOW,
        statePatch: (p) => ({ watermark: 12345, lastConsolidatedAt: NOW, lastSummary: p.summary }),
      },
    );
    expect(plan.summary.added).toBe(1);
    expect((await listMemoryEntries())[0]!.title).toBe("住在杭州");
    expect((await getMemoryProfile()).text).toBe("用户住在杭州。");
    const state = await getMemoryState();
    expect(state.watermark).toBe(12345);
    expect(state.lastSummary?.added).toBe(1);
  });

  it("delete entries writes an undo record usable once", async () => {
    const res = await rememberEntry({ kind: "about", title: "住在杭州", body: "西湖区", now: NOW });
    expect(res.ok).toBe(true);
    const { count, eventId } = await deleteMemoryEntries(["m_nope"]);
    expect(count).toBe(0);

    const [e] = await listMemoryEntries();
    const del = await deleteMemoryEntries([e!.id]);
    expect(del.count).toBe(1);
    expect(await listMemoryEntries()).toHaveLength(0);
    expect((await undoMemoryEvent(del.eventId!)).ok).toBe(true);
    expect(await listMemoryEntries()).toHaveLength(1);
    expect((await undoMemoryEvent(del.eventId!)).ok).toBe(false);
    expect(eventId).toBeNull();
  });
});

describe("usage + expiry", () => {
  it("records usage counts", async () => {
    const res = await rememberEntry({ kind: "about", title: "住在杭州", body: "西湖区", now: NOW });
    if (!res.ok) throw new Error("setup");
    await recordMemoryUsage([res.id], NOW);
    const [e] = await listMemoryEntries();
    expect(e!.useCount).toBe(1);
    expect(e!.lastUsedAt).toBe(NOW);
  });

  it("clears stale recent fragments only", async () => {
    await applyMemoryOps(
      [
        { op: "add", kind: "recent", title: "在比降噪耳机", body: "预算 2000" },
        { op: "add", kind: "preference", title: "一等座", body: "公司报销" },
      ],
      { origin: "consolidated", now: NOW - MEMORY_RECENT_TTL_MS - 1000 },
    );
    const before = await listMemoryEntries();
    expect(before).toHaveLength(2);
    const removed = await expireStaleRecent(NOW);
    expect(removed).toHaveLength(1);
    const after = await listMemoryEntries();
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe("preference");
  });
});

describe("settings + clear + snapshot", () => {
  it("defaults to enabled with no exclusions", async () => {
    const s = await getMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.excludedDomains).toEqual([]);
  });

  it("persists the toggle and domain list", async () => {
    await setMemorySettings({ enabled: false, excludedDomains: ["mail.example.com"] });
    const s = await getMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.excludedDomains).toEqual(["mail.example.com"]);
  });

  it("clearAllMemory wipes entries/profile/snapshot but keeps settings", async () => {
    await setMemorySettings({ enabled: true, excludedDomains: ["x.com"] });
    await rememberEntry({ kind: "about", title: "住在杭州", body: "西湖区", now: NOW });
    await setMemoryProfileText("画像", NOW);
    await saveMemorySnapshot(NOW);
    await clearAllMemory();
    expect(await listMemoryEntries({ includeExpired: true })).toHaveLength(0);
    expect((await getMemoryProfile()).text).toBe("");
    expect(await getMemorySnapshot()).toBeNull();
    expect((await getMemorySettings()).excludedDomains).toEqual(["x.com"]);
  });

  it("compaction snapshot restores the pre-cleanup store and drops later writes", async () => {
    await applyMemoryOps(
      [{ op: "add", kind: "preference", title: "一等座", body: "公司报销" }],
      { origin: "consolidated", now: NOW },
    );
    await setMemoryProfileText("旧画像", NOW);
    await saveMemorySnapshot(NOW);
    // Cleanup replaces the entry + profile, then adds a brand-new entry.
    await applyMemoryOps(
      [
        { op: "profile", text: "新画像" },
        { op: "add", kind: "about", title: "住在杭州", body: "西湖区" },
      ],
      { origin: "consolidated", now: NOW + 1000 },
    );
    expect((await getMemoryProfile()).text).toBe("新画像");

    expect(await restoreMemorySnapshot()).toBe(true);
    const restored = await listMemoryEntries();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.title).toBe("一等座");
    expect((await getMemoryProfile()).text).toBe("旧画像");
    expect(await getMemorySnapshot()).toBeNull();
    expect(await getMemoryEntry(restored[0]!.id)).not.toBeNull();
    expect(MEMORY_PROFILE_ID).toBe("profile");
  });

  it("manual edits pin the entry and mark origin=user", async () => {
    const res = await rememberEntry({ kind: "about", title: "住在杭州", body: "西湖区", now: NOW });
    if (!res.ok) throw new Error("setup");
    await updateMemoryEntry(res.id, { title: "住在杭州", body: "滨江区" });
    const e = await getMemoryEntry(res.id);
    expect(e!.body).toBe("滨江区");
    expect(e!.pinned).toBe(true);
    expect(e!.origin).toBe("user");
  });
});
