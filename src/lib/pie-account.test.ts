import { describe, expect, it, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import { createInstance, listInstances, updateInstance } from "./instances";
import { cacheEntitlement, _clearEntitlementCacheForTests, getCachedEntitlement } from "./managed-account";
import { clearAllMemory, getMemoryState, listMemoryEntries, rememberEntry, setMemoryState } from "./memory/store";
import { acceptPrivacyPolicy, getPrivacyConsent } from "./privacy-consent";
import { getPieAccount, savePieAccount, signOutPieAccount } from "./pie-account";
import type { LoginResult } from "./managed-auth";

const ent = (plan: LoginResult["entitlement"]["plan"], email = "u@x.com") => ({
  plan,
  email,
  subscription: null,
  quota: null,
  models: [],
});

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
  _clearEntitlementCacheForTests();
});

describe("getPieAccount", () => {
  it("没有 managed instance 时返回 null", async () => {
    await createInstance({ provider: "anthropic", nickname: "BYOK", apiKey: "sk-a" });
    expect(await getPieAccount()).toBeNull();
  });

  it("返回唯一 managed instance 的账号三要素", async () => {
    const id = await createInstance({ provider: "managed", nickname: "me@x.com", apiKey: "sk-v" });
    expect(await getPieAccount()).toEqual({ instanceId: id, apiKey: "sk-v", email: "me@x.com" });
  });

  it("已登录但 key 为空（异常存档）按未登录处理", async () => {
    await createInstance({ provider: "managed", nickname: "me@x.com", apiKey: "sk-v" });
    const [inst] = await listInstances();
    await updateInstance(inst!.id, { apiKey: "" });
    expect(await getPieAccount()).toBeNull();
  });
});

describe("savePieAccount（登录即落盘）", () => {
  it("首次登录建 managed instance，昵称取邮箱", async () => {
    const acct = await savePieAccount({ apiKey: "sk-v", entitlement: ent("none", "a@b.com") });
    const insts = await listInstances();
    expect(insts).toHaveLength(1);
    expect(insts[0]).toMatchObject({ id: acct.instanceId, provider: "managed", nickname: "a@b.com", apiKey: "sk-v" });
  });

  it("重复登录是幂等的：同一 instanceId，key/邮箱跟着刷新", async () => {
    const first = await savePieAccount({ apiKey: "sk-old", entitlement: ent("none", "a@b.com") });
    const second = await savePieAccount({ apiKey: "sk-new", entitlement: ent("active", "a@b.com") });
    expect(second.instanceId).toBe(first.instanceId);
    expect((await listInstances())[0]).toMatchObject({ apiKey: "sk-new", nickname: "a@b.com" });
  });

  it("BYOK 配置不受影响", async () => {
    await createInstance({ provider: "anthropic", nickname: "Key", apiKey: "sk-a" });
    await savePieAccount({ apiKey: "sk-v", entitlement: ent("none") });
    expect((await listInstances()).map((i) => i.provider).sort()).toEqual(["anthropic", "managed"]);
  });
});

describe("signOutPieAccount", () => {
  it("删 instance + 清 entitlement 缓存 + 清本地记忆与同步游标", async () => {
    await createInstance({ provider: "anthropic", nickname: "Key", apiKey: "sk-a" });
    const acct = await savePieAccount({ apiKey: "sk-v", entitlement: ent("active") });
    await cacheEntitlement("sk-v", ent("active"));
    expect(await getConfig("managed_entitlement_sk-v")).toBeTruthy();
    await rememberEntry({ kind: "preference", title: "喜欢深色主题", body: "用户偏好深色" });
    await setMemoryState({ cloudRevision: 7, cloudImported: true, digestWatermark: 42 });
    await acceptPrivacyPolicy("subscribe");
    expect((await listMemoryEntries()).length).toBeGreaterThan(0);

    await signOutPieAccount();

    expect(await getPieAccount()).toBeNull();
    expect(await getPrivacyConsent()).toBeNull();
    const rest = await listInstances();
    expect(rest.map((i) => i.provider)).toEqual(["anthropic"]); // BYOK 留着
    expect(await getConfig(`managed_entitlement_${acct.apiKey}`)).toBeUndefined();
    expect(getCachedEntitlement(acct.apiKey)).toBeNull();
    expect(await listMemoryEntries()).toEqual([]);
    const state = await getMemoryState();
    expect(state.cloudRevision).toBeUndefined();
    expect(state.cloudImported).toBeUndefined();
    // 不调云端 /memory/clear：这里只验证没有 fetch 依赖（函数签名无 deps）
  });

  it("未登录时退出是 no-op（不抛）", async () => {
    await expect(signOutPieAccount()).resolves.toBeUndefined();
  });

  it("clearAllMemory 只动本地，不触发云端请求", async () => {
    // 退出登录用的是 store 层清理（非 sync 层），这里守一道：不注入 fetch 也能跑通。
    await cacheEntitlement("sk-v", ent("active"));
    await setConfig("managed_entitlement_sk-v", ent("active"));
    await expect(clearAllMemory()).resolves.toBeUndefined();
    expect(await getConfig("managed_entitlement_sk-v")).toBeTruthy();
  });
});
