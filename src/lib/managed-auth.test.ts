import { describe, expect, it, vi } from "vitest";
import { EmailCodeError, sendEmailCode, startManagedLogin, verifyEmailCode } from "./managed-auth";
import { getPieAccount } from "./pie-account";
import { getCachedEntitlement, _clearEntitlementCacheForTests } from "./managed-account";
import { getConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";

const redirectUri = "https://abc.chromiumapp.org/";
const deps = (over: Partial<Parameters<typeof startManagedLogin>[0]> = {}) => ({
  getRedirectURL: () => redirectUri,
  launchWebAuthFlow: vi.fn(async () => `${redirectUri}?code=AUTHCODE`),
  fetchFn: vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ apiKey: "sk-virtual", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } }),
  })) as unknown as typeof fetch,
  ...over,
});

describe("startManagedLogin", () => {
  it("exchanges the code and returns apiKey + entitlement", async () => {
    const d = deps({ locale: "en" });
    const res = await startManagedLogin(d);
    expect(d.launchWebAuthFlow).toHaveBeenCalledWith({
      url: `https://account.pie.chat/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
      interactive: true,
    });
    expect(d.fetchFn).toHaveBeenCalledWith("https://account.pie.chat/auth/exchange?locale=en", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "AUTHCODE", redirectUri }),
    }));
    expect(res).toEqual({ apiKey: "sk-virtual", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } });
  });

  it("throws when the user cancels (no code in redirect)", async () => {
    await expect(startManagedLogin(deps({
      launchWebAuthFlow: vi.fn(async () => `${redirectUri}?error=access_denied`),
    }))).rejects.toThrow();
  });

  it("throws when exchange returns non-200", async () => {
    await expect(startManagedLogin(deps({
      fetchFn: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch,
    }))).rejects.toThrow();
  });

  it("登录成功后回填 entitlement 缓存（内存 + IDB）", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    const res = await startManagedLogin(deps({ locale: "en" }));
    expect(getCachedEntitlement("sk-virtual")).toEqual(res.entitlement);
    expect(await getConfig("managed_entitlement_sk-virtual")).toEqual(res.entitlement);
  });
});

describe("邮箱验证码登录", () => {
  const okFetch = (body: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

  it("sendEmailCode POST /auth/email/start（带 locale）", async () => {
    const fetchFn = okFetch({ ok: true });
    await sendEmailCode("a@b.com", { fetchFn, locale: "zh-CN" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/auth/email/start?locale=zh-CN", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
  });

  it("429 too_many_attempts 带上 retryAfter", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "too_many_attempts", retryAfter: 42 }),
    })) as unknown as typeof fetch;
    const err = await sendEmailCode("a@b.com", { fetchFn, locale: "en" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailCodeError);
    expect(err).toMatchObject({ code: "too_many_attempts", status: 429, retryAfter: 42 });
  });

  it("错误体不是 JSON 时回落到 fallback code", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    const err = await sendEmailCode("a@b.com", { fetchFn, locale: "en" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "mail_send_failed", status: 502 });
  });

  it("verify 成功：返回 LoginResult、回填 entitlement 缓存并落盘账号", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    const fetchFn = okFetch({
      apiKey: "sk-email",
      entitlement: { plan: "none", email: "a@b.com", subscription: null, quota: null, models: [] },
    });
    const res = await verifyEmailCode("a@b.com", "123456", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://account.pie.chat/auth/email/verify?locale=en",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "a@b.com", code: "123456" }) }),
    );
    expect(res.apiKey).toBe("sk-email");
    expect(getCachedEntitlement("sk-email")).toEqual(res.entitlement);
    // 登录即落盘：手机 key 与邮箱进了 managed instance，plan:none 也照样登录
    expect(await getPieAccount()).toMatchObject({ apiKey: "sk-email", email: "a@b.com" });
  });

  it("verify 400 invalid_code → EmailCodeError", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_code" }),
    })) as unknown as typeof fetch;
    const err = await verifyEmailCode("a@b.com", "000000", { fetchFn, locale: "en" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_code", status: 400 });
  });
});
