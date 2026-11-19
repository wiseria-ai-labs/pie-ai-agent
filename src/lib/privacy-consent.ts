// src/lib/privacy-consent.ts
//
// 2.0 隐私条款与云端记忆同意状态管理：
//   - 新用户开通订阅或兑换时，在界面明确告知默认同意并记录（source: "subscribe" | "redeem"）；
//   - 已订阅老用户首次打开 2.0 时弹窗引导查看更新后的隐私政策，可选择同意开启或暂不开启云端记忆；
//   - 若用户在首次提醒后未同意，Settings 用户栏持续显示提示点，点击进入账号页即可查看官网条款并同意；
//   - 支持跨设备同步：任一设备同意后（或新开通同步到云端后），其余设备在下次拉取状态时自动恢复上传。

import { getLocale, type Locale } from "./i18n";
import { getConfig, removeConfig, setConfig } from "./idb/config-store";
import type { Entitlement } from "./managed-auth";
import { memoryRequiresSubscription } from "./memory/model";
import { websiteLocalePath } from "./update-changelog";

export const PRIVACY_POLICY_URL = "https://www.pie.chat/privacy";
export const CURRENT_PRIVACY_VERSION = "2.0";
export const PRIVACY_CONSENT_KEY = "privacy_consent_v2";

/** 按当前界面语言构造官网《隐私政策》地址（英文根路径，其余语言带 locale 前缀）。 */
export function getPrivacyPolicyUrl(locale: Locale = getLocale()): string {
  const path = websiteLocalePath(locale);
  return `https://www.pie.chat/${path}privacy`;
}

export type PrivacyConsentSource =
  | "subscribe"
  | "redeem"
  | "upgrade_prompt"
  | "memory_settings"
  | "account_page"
  | "cloud_sync";

export interface PrivacyConsentRecord {
  version: string;
  status: "accepted" | "declined_memory";
  updatedAt: number;
  source: PrivacyConsentSource;
}

let memoryCloudConsentOverride: boolean | null = null;

/** Test-only：覆盖云端记忆同意门控（传 null 恢复默认读取存储状态）。 */
export function _setMemoryCloudConsentForTests(v: boolean | null): void {
  memoryCloudConsentOverride = v;
}

export async function getPrivacyConsent(): Promise<PrivacyConsentRecord | null> {
  try {
    const rec = await getConfig<unknown>(PRIVACY_CONSENT_KEY);
    if (rec == null || typeof rec !== "object") return null;
    const r = rec as Partial<PrivacyConsentRecord>;
    if (
      r.version !== CURRENT_PRIVACY_VERSION ||
      (r.status !== "accepted" && r.status !== "declined_memory")
    ) {
      return null;
    }
    return {
      version: r.version,
      status: r.status,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      source:
        r.source === "subscribe" ||
        r.source === "redeem" ||
        r.source === "upgrade_prompt" ||
        r.source === "memory_settings" ||
        r.source === "account_page" ||
        r.source === "cloud_sync"
          ? r.source
          : "subscribe",
    };
  } catch {
    return null;
  }
}

export async function acceptPrivacyPolicy(
  source: PrivacyConsentSource,
): Promise<PrivacyConsentRecord> {
  const rec: PrivacyConsentRecord = {
    version: CURRENT_PRIVACY_VERSION,
    status: "accepted",
    updatedAt: Date.now(),
    source,
  };
  await setConfig(PRIVACY_CONSENT_KEY, rec);
  return rec;
}

export async function declineCloudMemoryConsent(): Promise<PrivacyConsentRecord> {
  const rec: PrivacyConsentRecord = {
    version: CURRENT_PRIVACY_VERSION,
    status: "declined_memory",
    updatedAt: Date.now(),
    source: "upgrade_prompt",
  };
  await setConfig(PRIVACY_CONSENT_KEY, rec);
  return rec;
}

export async function clearPrivacyConsent(): Promise<void> {
  await removeConfig(PRIVACY_CONSENT_KEY);
}

/**
 * 是否允许将记忆摘录上传至云端。
 * - 单测纯本地模式（MEMORY_REQUIRES_SUBSCRIPTION = false）默认放行；
 * - 生产/订阅模式必须明确记录过 status === "accepted"。
 */
export async function hasMemoryCloudConsent(): Promise<boolean> {
  if (memoryCloudConsentOverride !== null) return memoryCloudConsentOverride;
  if (!memoryRequiresSubscription()) return true;
  return (await getPrivacyConsent())?.status === "accepted";
}

/**
 * 已订阅用户首次打开 2.0 版本时是否需要弹出隐私更新引导：
 * - 若云端 entitlement 已下发 `privacyConsent: true`（例如在另一台设备已同意，或新开通默认同意），
 *   自动同步为本机已同意并返回 false（不再弹窗）；
 * - 否则仅当订阅生效（plan === "active"）且本设备尚未处理过当前版本条款时返回 true。
 */
export async function needsPrivacyUpdatePrompt(
  entitlement: Entitlement | null | undefined,
): Promise<boolean> {
  if (entitlement?.plan !== "active") return false;
  if (entitlement.privacyConsent === true) {
    const existing = await getPrivacyConsent();
    if (existing?.status !== "accepted") {
      await acceptPrivacyPolicy("cloud_sync");
    }
    return false;
  }
  return (await getPrivacyConsent()) === null;
}
