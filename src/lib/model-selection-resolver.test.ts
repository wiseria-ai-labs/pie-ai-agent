import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { resolveSelection } from "./model-selection-resolver";
import { createInstance } from "./instances";
import { setLastModelSelection } from "./last-model-selection";
import { cacheEntitlement, _clearEntitlementCacheForTests } from "./managed-account";
import { _resetForTests, STORES, tx } from "./idb/db";
import { _resetKeyForTests } from "./crypto";

// Instances + last_model_selection now persist in IDB. Reset the `pie` db per
// test so instances/last-selection from a prior test can't leak into the
// "no instances configured" / first-instance-fallback cases.
beforeEach(async () => {
  chromeMock.storage.local.__store = {};
  await _resetForTests();
  _resetKeyForTests();
  _clearEntitlementCacheForTests();
});

const ent = (plan: "none" | "active" | "blocked", apiKey: string) =>
  cacheEntitlement(apiKey, { plan, email: "a@b.com", subscription: null, quota: null, models: [] });

describe("resolveSelection", () => {
  it("prefers session's own instanceId + model", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const sel = await resolveSelection({ instanceId: id, model: "claude-opus-5" });
    expect(sel).toEqual({ instanceId: id, model: "claude-opus-5" });
  });

  it("falls back to last_model_selection when session has none", async () => {
    const id = await createInstance({ provider: "openai", nickname: "O", apiKey: "k" });
    await setLastModelSelection({ instanceId: id, model: "gpt-4o" });
    const sel = await resolveSelection({});
    expect(sel).toEqual({ instanceId: id, model: "gpt-4o" });
  });

  it("falls back to first instance's first registry model", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const sel = await resolveSelection({});
    expect(sel).toEqual({ instanceId: id, model: "claude-opus-5" });
  });

  it("keeps a session model that was dropped from the registry (never swaps in an empty/other model)", async () => {
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "payg" });
    const sel = await resolveSelection({ instanceId: id, model: "kimi-k2.5" });
    expect(sel).toEqual({ instanceId: id, model: "kimi-k2.5" });
  });

  it("returns null when no instances configured", async () => {
    expect(await resolveSelection({})).toBeNull();
  });

  it("session instanceId but no model → backfills via firstModelForProvider", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const sel = await resolveSelection({ instanceId: id });
    expect(sel).toEqual({ instanceId: id, model: "claude-opus-5" });
  });

  it("ignores a stale (deleted) session instanceId and falls back to last", async () => {
    const id = await createInstance({ provider: "openai", nickname: "O", apiKey: "k" });
    await setLastModelSelection({ instanceId: id, model: "gpt-4o" });
    const sel = await resolveSelection({ instanceId: "ghost", model: "x" });
    expect(sel).toEqual({ instanceId: id, model: "gpt-4o" });
  });
});

describe("resolveSelection — 已登录未订阅的官方账号不可选", () => {
  it("plan none 的 managed 且没有其它配置 → null（零配置空态）", async () => {
    await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-none" });
    await ent("none", "sk-none");
    expect(await resolveSelection({})).toBeNull();
  });

  it("plan none 的 managed + 一条 BYOK → 落到 BYOK", async () => {
    await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-none" });
    const byok = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    await ent("none", "sk-none");
    expect(await resolveSelection({})).toEqual({ instanceId: byok, model: "claude-opus-5" });
  });

  it("session 绑了 plan none 的 managed → 继续落到 BYOK", async () => {
    const managed = await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-none" });
    const byok = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    await ent("none", "sk-none");
    expect(await resolveSelection({ instanceId: managed, model: "default" })).toEqual({
      instanceId: byok,
      model: "claude-opus-5",
    });
  });

  it("last_model_selection 指向 plan none 的 managed → 继续落到 BYOK", async () => {
    const managed = await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-none" });
    const byok = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k" });
    await ent("none", "sk-none");
    await setLastModelSelection({ instanceId: managed, model: "default" });
    expect(await resolveSelection({})).toEqual({ instanceId: byok, model: "kimi-for-coding" });
  });

  it("缓存未水合（null）→ 仍选 managed（旧行为）", async () => {
    const managed = await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-cold" });
    expect(await resolveSelection({})).toEqual({ instanceId: managed, model: "default" });
  });

  it("plan active → managed 照常可选", async () => {
    const managed = await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-active" });
    await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    await ent("active", "sk-active");
    expect(await resolveSelection({})).toEqual({ instanceId: managed, model: "default" });
  });

  it("plan blocked 同样跳过", async () => {
    await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-blocked" });
    await ent("blocked", "sk-blocked");
    expect(await resolveSelection({})).toBeNull();
  });

  it("陈旧内存缓存（plan:none）但 IDB 已刷新为 active → 重新水合后命中 managed，不回落到 BYOK", async () => {
    const byok = await createInstance({ provider: "moonshot-cn", nickname: "Kimi", apiKey: "k-bad" });
    const managed = await createInstance({ provider: "managed", nickname: "a@b.com", apiKey: "sk-upg" });
    // 1) 先在当前上下文（模拟 SW）缓存了订阅前的 plan:none
    await ent("none", "sk-upg");
    // 2) 模拟另一上下文（Panel）刷新 IDB 为 active，绕过同进程 BroadcastChannel
    await tx(STORES.config, "readwrite", (s) =>
      s.put({
        key: "managed_entitlement_sk-upg",
        value: {
          plan: "active",
          email: "a@b.com",
          subscription: null,
          quota: null,
          models: [{ id: "default", name: "Standard", vision: false, maxContextTokens: 128000, costLevel: 1 }],
        },
      }),
    );
    await setLastModelSelection({ instanceId: managed, model: "default" });
    expect(byok).not.toBe(managed);
    expect(await resolveSelection({ instanceId: managed, model: "default" })).toEqual({
      instanceId: managed,
      model: "default",
    });
  });
});
