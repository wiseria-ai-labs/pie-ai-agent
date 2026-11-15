import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { createInstance } from "@/lib/instances";
import {
  cacheEntitlement,
  _clearEntitlementCacheForTests,
} from "@/lib/managed-account";
import { _setMemoryRequiresSubscriptionForTests } from "@/lib/memory/model";
import { _resetMemorySyncForTests } from "@/lib/memory/sync";
import { MEMORY_TOOLS, isMemoryToolName } from "./memory";
import { listMemoryEntries, rememberEntry, setMemorySettings } from "@/lib/memory/store";
import type { ToolHandlerContext } from "../types";

const ctx: ToolHandlerContext = { tabId: 1, signal: undefined };

function tool(name: string) {
  const t = MEMORY_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
  _clearEntitlementCacheForTests();
  _resetMemorySyncForTests();
  _setMemoryRequiresSubscriptionForTests(false);
});

afterEach(() => {
  _setMemoryRequiresSubscriptionForTests(null);
  _clearEntitlementCacheForTests();
  _resetMemorySyncForTests();
  vi.unstubAllGlobals();
});

describe("remember", () => {
  it("saves immediately and returns an undoable memory event", async () => {
    const res = await tool("remember").handler(
      { kind: "preference", title: "高铁坐一等座", body: "公司报销" },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(res.memoryEvent?.kind).toBe("updated");
    expect(res.memoryEvent?.eventId).toMatch(/^undo_/);
    expect(await listMemoryEntries()).toHaveLength(1);
  });

  it("refuses when automatic memory is off", async () => {
    await setMemorySettings({ enabled: false });
    const res = await tool("remember").handler(
      { kind: "about", title: "住在杭州", body: "西湖区" },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("turned off");
  });

  it("rejects credentials and bad kinds", async () => {
    const secret = await tool("remember").handler(
      { kind: "about", title: "卡号", body: "6222021234567890123" },
      ctx,
    );
    expect(secret.success).toBe(false);
    expect(secret.error).toContain("credential");

    const badKind = await tool("remember").handler({ kind: "nope", title: "x" }, ctx);
    expect(badKind.success).toBe(false);
    expect(badKind.error).toContain("kind must be one of");
  });

  it("refuses to save anything from an incognito window (§5.3 从不记住)", async () => {
    chromeMock.tabs.__tabsById.set(1, {
      id: 1,
      url: "https://example.com/",
      incognito: true,
    } as unknown as { id: number; url: string });
    const res = await tool("remember").handler(
      { kind: "about", title: "住在杭州", body: "西湖区" },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("incognito");
    expect(await listMemoryEntries()).toHaveLength(0);
  });
});

describe("forget", () => {
  it("deletes by query and leaves an undo event", async () => {
    await rememberEntry({ kind: "about", title: "住在滨江", body: "滨江区" });
    await rememberEntry({ kind: "preference", title: "高铁坐一等座", body: "公司报销" });
    const res = await tool("forget").handler({ query: "滨江" }, ctx);
    expect(res.success).toBe(true);
    expect(res.memoryEvent?.count).toBe(1);
    expect(res.memoryEvent?.kind).toBe("deleted");
    const left = await listMemoryEntries();
    expect(left).toHaveLength(1);
    expect(left[0]!.title).toBe("高铁坐一等座");
  });

  it("reports an honest no-op", async () => {
    const res = await tool("forget").handler({ query: "没有这条" }, ctx);
    expect(res.success).toBe(true);
    expect(res.memoryEvent).toBeUndefined();
    expect(res.observation).toContain("no matching memory");
  });

  it("requires an id or query", async () => {
    const res = await tool("forget").handler({}, ctx);
    expect(res.success).toBe(false);
  });
});

describe("recall_memory", () => {
  it("returns empty when memory is not in cloud_active mode", async () => {
    // 非活跃订阅态（local_dev / locked）直接返回空结果。
    const res = await tool("recall_memory").handler({ query: "我上次说的地址" }, ctx);
    expect(res.success).toBe(true);
    expect(res.observation).toBe("No relevant memories found.");
  });

  it("requires a query", async () => {
    const res = await tool("recall_memory").handler({}, ctx);
    expect(res.success).toBe(false);
  });
});

describe("tool naming", () => {
  it("exposes exactly the three spec tools", () => {
    expect(MEMORY_TOOLS.map((t) => t.name)).toEqual(["remember", "forget", "recall_memory"]);
    expect(isMemoryToolName("remember")).toBe(true);
    expect(isMemoryToolName("recall")).toBe(false);
  });
});

describe("Pie Pro subscription gate & cloud routing", () => {
  it("refuses remember, forget, and recall_memory when unsubscribed (locked) or expired (readonly_expired)", async () => {
    _setMemoryRequiresSubscriptionForTests(true);

    // Locked (no managed instance / no retained memories)
    for (const [name, args] of [
      ["remember", { kind: "preference", title: "深色模式", body: "偏爱" }],
      ["forget", { query: "深色" }],
      ["recall_memory", { query: "深色" }],
    ] as const) {
      const res = await tool(name).handler(args, ctx);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Pie Pro subscription/);
    }

    // Retained local memory + expired subscription ("none") -> still read-only / refused for tools
    await rememberEntry({ kind: "preference", title: "深色模式", body: "偏爱" });
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_expired" });
    await cacheEntitlement("mk_expired", {
      plan: "none",
      email: "a@b.com",
      subscription: null,
      quota: null,
      models: [],
    });

    for (const [name, args] of [
      ["remember", { kind: "about", title: "城市", body: "北京" }],
      ["forget", { query: "深色" }],
      ["recall_memory", { query: "深色" }],
    ] as const) {
      const res = await tool(name).handler(args, ctx);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Pie Pro subscription/);
    }
  });

  it("routes remember, recall_memory, and forget through cloud APIs and syncs mirror when Pie Pro is active", async () => {
    _setMemoryRequiresSubscriptionForTests(true);
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_active" });
    await cacheEntitlement("mk_active", {
      plan: "active",
      email: "pro@pie.chat",
      subscription: {
        planName: "Pie Pro",
        currentPeriodEnd: Date.now() + 86_400_000,
        cancelAtPeriodEnd: false,
        source: "stripe",
        interval: "month",
      },
      quota: { weekly: { usedFraction: 0.1, resetAt: Date.now() + 86_400_000 } },
      models: [],
    });

    const entry = {
      id: "m_cloud1",
      kind: "preference",
      title: "高铁坐一等座",
      body: "公司报销",
      tags: ["高铁"],
      createdAt: 1000,
      updatedAt: 1000,
      validFrom: 1000,
      validTo: null,
      useCount: 0,
      lastUsedAt: null,
      pinned: false,
      encrypted: false,
      origin: "explicit",
    };

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/memory/remember")) {
          return new Response(
            JSON.stringify({
              ok: true,
              id: entry.id,
              revision: 2,
              entry,
              event: { eventId: "undo_cloud1", kind: "updated", label: entry.title },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/memory/pick")) {
          return new Response(
            JSON.stringify({ revision: 2, entries: [entry] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/memory/forget")) {
          return new Response(
            JSON.stringify({
              revision: 3,
              count: 1,
              deletedIds: [entry.id],
              eventId: "undo_cloud2",
              label: entry.title,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ unchanged: true, revision: 3, readOnly: false }), {
          status: 200,
        });
      }),
    );

    const rem = await tool("remember").handler(
      { kind: "preference", title: "高铁坐一等座", body: "公司报销" },
      ctx,
    );
    expect(rem.success).toBe(true);
    expect(rem.memoryEvent?.eventId).toBe("undo_cloud1");
    expect((await listMemoryEntries()).map((e) => e.id)).toEqual(["m_cloud1"]);

    const rec = await tool("recall_memory").handler({ query: "怎么订票" }, ctx);
    expect(rec.success).toBe(true);
    expect(rec.observation).toContain("高铁坐一等座");

    const fgt = await tool("forget").handler({ query: "高铁" }, ctx);
    expect(fgt.success).toBe(true);
    expect(fgt.memoryEvent?.count).toBe(1);
    expect(await listMemoryEntries()).toHaveLength(0);

    expect(calls.some((u) => u.endsWith("/memory/remember"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/memory/pick"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/memory/forget"))).toBe(true);
  });
});
