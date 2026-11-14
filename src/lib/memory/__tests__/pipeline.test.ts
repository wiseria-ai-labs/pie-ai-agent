import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import type { ModelConfig } from "@/lib/model-router";
import type { SessionIndexEntry, SessionMeta } from "@/lib/sessions/types";
import {
  buildSessionExcerpt,
  isSessionExcluded,
  runDailyConsolidation,
  shouldConsolidate,
  stripUntrustedBlocks,
} from "../consolidate";
import { isNearCapacity, isNewMonth, nextCompactionAt, runMonthlyCompaction, shouldCompact } from "../compact";
import { pickMemory } from "../selector";
import {
  applyMemoryOps,
  getMemoryProfile,
  getMemorySnapshot,
  getMemoryState,
  listMemoryEntries,
  restoreMemorySnapshot,
  setMemorySettings,
} from "../store";
import { MEMORY_CONSOLIDATE_MIN_INTERVAL_MS, MEMORY_PICK_DAILY_CAP } from "../types";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const model: ModelConfig = {
  provider: "deepseek",
  model: "deepseek-flash",
  apiKey: "test-key",
};

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s1",
    createdAt: NOW - 2 * HOUR,
    lastAccessedAt: NOW - HOUR,
    status: "active",
    messages: [],
    ...over,
  };
}

const sessions: SessionIndexEntry[] = [
  { id: "s1", lastAccessedAt: NOW - 3 * HOUR, status: "active", title: "订高铁" },
  { id: "s2", lastAccessedAt: NOW - HOUR, status: "active", title: "回复邮件" },
  { id: "s0", lastAccessedAt: NOW - 30 * HOUR, status: "active", title: "更早的会话" },
];

const metas: Record<string, SessionMeta> = {
  s1: meta({
    id: "s1",
    messages: [
      { role: "user", content: "以后都订一等座，公司报销" },
      { role: "assistant", content: "好的，记下了。" },
    ],
  }),
  s2: meta({
    id: "s2",
    messages: [{ role: "user", content: "用中文写邮件，语气简洁" }],
  }),
  s0: meta({ id: "s0", messages: [{ role: "user", content: "旧会话" }] }),
};

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("consolidation input", () => {
  it("strips page-quote blocks from user messages", () => {
    const raw = "看一下 <untrusted_page_quote>网页原文</untrusted_page_quote> 这段";
    expect(stripUntrustedBlocks(raw)).toBe("看一下 这段");
  });

  it("keeps user messages + the last assistant conclusion", () => {
    const text = buildSessionExcerpt(
      meta({
        messages: [
          { role: "user", content: "问题一" },
          { role: "assistant", content: "中间回答" },
          { role: "user", content: "问题二" },
          { role: "assistant", content: "最终结论" },
        ],
      }),
    );
    expect(text).toContain("[user] 问题一");
    expect(text).toContain("[user] 问题二");
    expect(text).toContain("[assistant] 最终结论");
    expect(text).not.toContain("中间回答");
  });

  it("skips sessions whose pinned origins are all excluded", () => {
    const m = meta({ pinnedTabs: [{ tabId: 1, origin: "https://mail.example.com" }] });
    expect(isSessionExcluded(m, ["example.com"])).toBe(true);
    expect(isSessionExcluded(m, ["other.com"])).toBe(false);
    expect(isSessionExcluded(meta({ pinnedTabs: [] }), ["example.com"])).toBe(false);
  });

  it("excludes incognito sessions unconditionally (spec §5.3 从不记住)", () => {
    expect(isSessionExcluded(meta({ incognito: true }), [])).toBe(true);
    expect(isSessionExcluded(meta({ incognito: true, pinnedTabs: [] }), [])).toBe(true);
  });

  it("requires 20h since the last run", () => {
    expect(shouldConsolidate(undefined, NOW)).toBe(true);
    expect(shouldConsolidate(NOW - MEMORY_CONSOLIDATE_MIN_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(shouldConsolidate(NOW - MEMORY_CONSOLIDATE_MIN_INTERVAL_MS, NOW)).toBe(true);
  });
});

describe("runDailyConsolidation", () => {
  const callModel = async () =>
    JSON.stringify({
      ops: [
        { op: "add", kind: "preference", title: "高铁坐一等座", body: "公司报销", source_session: "s1" },
        { op: "add", kind: "preference", title: "邮件语气", body: "中文，简洁", source_session: "s2" },
        { op: "profile", text: "用户偏好一等座与简洁邮件。" },
      ],
    });

  it("processes sessions after the watermark and advances it atomically", async () => {
    const summary = await runDailyConsolidation({
      model,
      now: NOW,
      listSessions: async () => sessions,
      readSession: async (id) => metas[id] ?? null,
      callModel,
    });
    expect(summary?.added).toBe(2);

    const state = await getMemoryState();
    // 水位线推进到「处理过的会话」的最新 lastAccessedAt
    expect(state.watermark).toBe(NOW - HOUR);
    expect(state.lastConsolidatedAt).toBe(NOW);
    expect((await listMemoryEntries()).map((e) => e.title).sort()).toEqual([
      "邮件语气",
      "高铁坐一等座",
    ]);
    expect((await getMemoryProfile()).text).toBe("用户偏好一等座与简洁邮件。");

    // 幂等：没有新会话 + 不到 20h → 什么都不做
    const again = await runDailyConsolidation({
      model,
      now: NOW + HOUR,
      listSessions: async () => sessions,
      readSession: async (id) => metas[id] ?? null,
      callModel,
    });
    expect(again).toBeNull();
  });

  it("does not advance the watermark when the model fails", async () => {
    const res = await runDailyConsolidation({
      model,
      now: NOW,
      listSessions: async () => sessions,
      readSession: async (id) => metas[id] ?? null,
      callModel: async () => null,
    });
    expect(res).toBeNull();
    expect((await getMemoryState()).watermark).toBe(0);
    expect(await listMemoryEntries()).toHaveLength(0);
  });

  it("skips entirely when memory is disabled or no model is configured", async () => {
    await setMemorySettings({ enabled: false });
    expect(
      await runDailyConsolidation({
        model,
        now: NOW,
        listSessions: async () => sessions,
        readSession: async (id) => metas[id] ?? null,
        callModel,
      }),
    ).toBeNull();
    await setMemorySettings({ enabled: true });
    expect(
      await runDailyConsolidation({
        model: null,
        now: NOW,
        listSessions: async () => sessions,
        readSession: async (id) => metas[id] ?? null,
        callModel,
      }),
    ).toBeNull();
  });

  it("advances the watermark without calling the model when every session is excluded", async () => {
    await setMemorySettings({ excludedDomains: ["example.com"] });
    const callSpy = vi.fn(callModel);
    const res = await runDailyConsolidation({
      model,
      now: NOW,
      listSessions: async () => sessions,
      readSession: async (id) =>
        meta({
          id,
          pinnedTabs: [{ tabId: 1, origin: "https://mail.example.com" }],
          messages: [{ role: "user", content: "秘密" }],
        }),
      callModel: callSpy,
    });
    expect(res).toBeNull();
    expect(callSpy).not.toHaveBeenCalled();
    expect((await getMemoryState()).watermark).toBe(NOW - HOUR);
    expect(await listMemoryEntries()).toHaveLength(0);
  });

  it("never feeds an incognito session to the model (§5.3 从不记住)", async () => {
    const callSpy = vi.fn(callModel);
    const res = await runDailyConsolidation({
      model,
      now: NOW,
      listSessions: async () => sessions.slice(0, 1),
      readSession: async (id) =>
        meta({ id, incognito: true, messages: [{ role: "user", content: "无痕里的私事" }] }),
      callModel: callSpy,
    });
    expect(res).toBeNull();
    expect(callSpy).not.toHaveBeenCalled();
    expect(await listMemoryEntries()).toHaveLength(0);
  });
});

describe("monthly compaction", () => {
  it("detects a new month and near-capacity", () => {
    expect(isNewMonth(undefined, NOW)).toBe(true);
    expect(isNewMonth(Date.UTC(2026, 9, 20), NOW)).toBe(true);
    expect(isNewMonth(Date.UTC(2026, 10, 1), NOW)).toBe(false);
    expect(shouldCompact(Date.UTC(2026, 10, 2), [], NOW)).toBe(false);
    expect(isNearCapacity([{ kind: "preference", title: "a", body: "b".repeat(19_000) }])).toBe(true);
  });

  it("points the next cleanup at the first day of the next month", () => {
    expect(nextCompactionAt(NOW)).toBe(new Date(2026, 11, 1).getTime());
    expect(nextCompactionAt(Date.UTC(2026, 11, 15))).toBe(new Date(2027, 0, 1).getTime());
  });

  it("snapshots before applying and can be undone", async () => {
    await applyMemoryOps(
      [
        { op: "profile", text: "旧画像" },
        { op: "add", kind: "preference", title: "一等座", body: "公司报销" },
      ],
      { origin: "consolidated", now: NOW - 40 * 24 * HOUR },
    );
    const summary = await runMonthlyCompaction({
      model,
      now: NOW,
      callModel: async () =>
        JSON.stringify({
          ops: [
            { op: "profile", text: "新画像" },
            { op: "add", kind: "preference", title: "出差", body: "都坐一等座" },
          ],
        }),
    });
    expect(summary?.profileRewritten).toBe(true);
    expect(await getMemorySnapshot()).not.toBeNull();
    expect((await getMemoryProfile()).text).toBe("新画像");
    expect((await getMemoryState()).lastCompactedAt).toBe(NOW);

    expect(await restoreMemorySnapshot()).toBe(true);
    expect((await getMemoryProfile()).text).toBe("旧画像");
    expect((await listMemoryEntries()).map((e) => e.title)).toEqual(["一等座"]);
  });

  it("does nothing before the month rolls over", async () => {
    await applyMemoryOps([{ op: "add", kind: "preference", title: "一等座", body: "x" }], {
      origin: "consolidated",
      now: NOW,
    });
    await applyMemoryOps([], {
      origin: "consolidated",
      now: NOW,
      statePatch: { lastCompactedAt: NOW },
    });
    const spy = vi.fn(async () => null);
    const res = await runMonthlyCompaction({ model, now: NOW + HOUR, callModel: spy });
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("pickMemory", () => {
  async function seed() {
    await applyMemoryOps(
      [
        { op: "add", kind: "preference", title: "高铁坐一等座", body: "公司报销" },
        { op: "add", kind: "about", title: "住在杭州", body: "西湖区" },
      ],
      { origin: "consolidated", now: NOW },
    );
    return listMemoryEntries();
  }

  it("returns the selected entries and records usage", async () => {
    const entries = await seed();
    const id = entries.find((e) => e.title === "高铁坐一等座")!.id;
    const picked = await pickMemory({
      task: "帮我订周三去上海的高铁",
      model,
      now: NOW,
      callModel: async () => JSON.stringify({ ids: [id, "m_does_not_exist"] }),
    });
    expect(picked.map((e) => e.id)).toEqual([id]);
    const after = await listMemoryEntries();
    expect(after.find((e) => e.id === id)!.useCount).toBe(1);
  });

  it("returns [] when memory is off, has no model, or the model says nothing", async () => {
    const entries = await seed();
    const id = entries[0]!.id;
    expect(
      await pickMemory({ task: "x", model, now: NOW, callModel: async () => JSON.stringify({ ids: [id] }) }),
    ).toHaveLength(1);
    await setMemorySettings({ enabled: false });
    expect(
      await pickMemory({ task: "x", model, now: NOW, callModel: async () => JSON.stringify({ ids: [id] }) }),
    ).toEqual([]);
    await setMemorySettings({ enabled: true });
    expect(
      await pickMemory({ task: "x", model: null, now: NOW, callModel: async () => JSON.stringify({ ids: [id] }) }),
    ).toEqual([]);
    expect(
      await pickMemory({ task: "x", model, now: NOW, callModel: async () => "I don't know." }),
    ).toEqual([]);
  });

  it("stops calling the model after the daily pick cap", async () => {
    await seed();
    const spy = vi.fn(async () => JSON.stringify({ ids: [] }));
    for (let i = 0; i < MEMORY_PICK_DAILY_CAP; i++) {
      await pickMemory({ task: "x", model, now: NOW, callModel: spy });
    }
    expect(spy).toHaveBeenCalledTimes(MEMORY_PICK_DAILY_CAP);
    await pickMemory({ task: "x", model, now: NOW, callModel: spy });
    expect(spy).toHaveBeenCalledTimes(MEMORY_PICK_DAILY_CAP);
  });
});
