import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTests } from "./idb/db";
import { setConfig } from "./idb/config-store";
import type { Entitlement } from "./managed-auth";
import { _setMemoryRequiresSubscriptionForTests } from "./memory/model";
import {
  _setMemoryCloudConsentForTests,
  acceptPrivacyPolicy,
  clearPrivacyConsent,
  CURRENT_PRIVACY_VERSION,
  declineCloudMemoryConsent,
  getPrivacyConsent,
  getPrivacyPolicyUrl,
  hasMemoryCloudConsent,
  needsPrivacyUpdatePrompt,
  PRIVACY_CONSENT_KEY,
} from "./privacy-consent";

const activeEnt: Entitlement = {
  plan: "active",
  email: "u@x.com",
  subscription: {
    planName: "Pie Pro",
    currentPeriodEnd: 1750000000,
    cancelAtPeriodEnd: false,
    source: "stripe",
  },
  quota: null,
  models: [],
};

const noneEnt: Entitlement = {
  plan: "none",
  email: "u@x.com",
  subscription: null,
  quota: null,
  models: [],
};

describe("privacy-consent", () => {
  beforeEach(async () => {
    await _resetForTests();
    _setMemoryRequiresSubscriptionForTests(true);
    _setMemoryCloudConsentForTests(null);
  });

  afterEach(() => {
    _setMemoryRequiresSubscriptionForTests(null);
    _setMemoryCloudConsentForTests(null);
  });

  it("defaults to no consent and blocks cloud memory uploads in subscription mode", async () => {
    expect(await getPrivacyConsent()).toBeNull();
    expect(await hasMemoryCloudConsent()).toBe(false);
    expect(await needsPrivacyUpdatePrompt(activeEnt)).toBe(true);
    expect(await needsPrivacyUpdatePrompt(noneEnt)).toBe(false);
    expect(await needsPrivacyUpdatePrompt(null)).toBe(false);
  });

  it("records accepted consent on subscribe/redeem/memory_settings and satisfies gates", async () => {
    const rec = await acceptPrivacyPolicy("subscribe");
    expect(rec.version).toBe(CURRENT_PRIVACY_VERSION);
    expect(rec.status).toBe("accepted");
    expect(rec.source).toBe("subscribe");

    expect(await getPrivacyConsent()).toEqual(rec);
    expect(await hasMemoryCloudConsent()).toBe(true);
    expect(await needsPrivacyUpdatePrompt(activeEnt)).toBe(false);
  });

  it("records declined_memory so modal does not re-prompt while cloud uploads remain blocked", async () => {
    const rec = await declineCloudMemoryConsent();
    expect(rec.status).toBe("declined_memory");
    expect(rec.source).toBe("upgrade_prompt");

    expect(await hasMemoryCloudConsent()).toBe(false);
    expect(await needsPrivacyUpdatePrompt(activeEnt)).toBe(false);
  });

  it("treats older policy versions as unconsented and re-prompts active users", async () => {
    await setConfig(PRIVACY_CONSENT_KEY, {
      version: "1.0",
      status: "accepted",
      updatedAt: 1000,
      source: "subscribe",
    });

    expect(await getPrivacyConsent()).toBeNull();
    expect(await hasMemoryCloudConsent()).toBe(false);
    expect(await needsPrivacyUpdatePrompt(activeEnt)).toBe(true);
  });

  it("clearPrivacyConsent resets state (used on sign-out)", async () => {
    await acceptPrivacyPolicy("redeem");
    expect(await hasMemoryCloudConsent()).toBe(true);

    await clearPrivacyConsent();
    expect(await getPrivacyConsent()).toBeNull();
    expect(await hasMemoryCloudConsent()).toBe(false);
  });

  it("allows memory in local_dev mode without subscription consent", async () => {
    _setMemoryRequiresSubscriptionForTests(false);
    expect(await hasMemoryCloudConsent()).toBe(true);
  });

  it("builds official website privacy policy URLs per locale", () => {
    expect(getPrivacyPolicyUrl("en")).toBe("https://www.pie.chat/privacy");
    expect(getPrivacyPolicyUrl("zh-CN")).toBe("https://www.pie.chat/zh-Hans/privacy");
    expect(getPrivacyPolicyUrl("zh-TW")).toBe("https://www.pie.chat/zh-Hant/privacy");
    expect(getPrivacyPolicyUrl("ja")).toBe("https://www.pie.chat/ja/privacy");
  });

  it("auto-syncs local consent and skips modal when entitlement reports cloud privacyConsent=true", async () => {
    await declineCloudMemoryConsent();
    expect(await hasMemoryCloudConsent()).toBe(false);

    const promptNeeded = await needsPrivacyUpdatePrompt({
      ...activeEnt,
      privacyConsent: true,
    });
    expect(promptNeeded).toBe(false);
    expect(await hasMemoryCloudConsent()).toBe(true);
    expect(await getPrivacyConsent()).toMatchObject({
      status: "accepted",
      source: "cloud_sync",
    });
  });
});
