import { ACCOUNT_BASE } from "./managed-config";
import { normalizeEntitlement, cacheEntitlement } from "./managed-account";
import { savePieAccount } from "./pie-account";
import { getLocale } from "./i18n";

export interface QuotaWindow {
  usedFraction: number;
  resetAt: number;
}
/** Deep Research 周额度（Pro 独占）。plan:none 时 entitlement.quota.research 为 undefined。 */
export interface ResearchQuotaWindow {
  weekly: number;
  used: number;
  resetAt: number;
}
export interface SubscriptionInfo {
  planName: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** 当前驱动 active 的来源：stripe（付费订阅，可开 portal）/ redemption（兑换码，无账单可管）。 */
  source: "stripe" | "redemption";
  /** 计费周期；仅 stripe source 有，redemption 省略。缺省按月付兜底显示。 */
  interval?: "month" | "year";
}
export interface ModelInfo {
  id: string;
  name: string;
  /** 一行能力描述（已按 locale 由后端解析）。 */
  description?: string;
  /** 是否支持图片输入。tools 对 managed 一律视 true。 */
  vision: boolean;
  maxContextTokens: number;
  /** 相对周额度消耗档（1=最省），渲染为 N/3 实心点。 */
  costLevel: 1 | 2 | 3;
}
export interface PricingInfo {
  /** ISO 货币码小写（Stripe 约定），交给 Intl 格式化。 */
  currency: string;
  monthly: { amount: number; introAmount?: number; introPercentOff?: number };
  annual: { amount: number; perMonthAmount: number; savePercent: number };
}
export interface Entitlement {
  plan: "none" | "active" | "blocked";
  email: string;
  /** plan==none 时为 null；blocked 时非 null（供更新支付）。 */
  subscription: SubscriptionInfo | null;
  /** plan!=active 时为 null；具名窗口 map（P3 可加 fiveHour）。
   *  `research` 为可选 Pro 独占额度；plan:none 时 normalize 为 undefined。 */
  quota: { weekly?: QuotaWindow; research?: ResearchQuotaWindow } | null;
  /** 仅 plan==active 非空。 */
  models: ModelInfo[];
  /** 仅"从未订过"且后端 feature 开时下发；客户端据此打"首月半价"徽标。缺省=无促销。 */
  introOffer?: { percentOff: number };
  /** 仅 plan:none、后端年付开+价格拉取成功时下发；存在=渲染价格卡，缺=回退单订阅按钮。仅展示价、客户端不计算。 */
  pricing?: PricingInfo;
  /** 云端持久化的 2.0 隐私条款（含云端记忆）同意状态，用于跨设备同步。 */
  privacyConsent?: boolean;
}
export interface LoginResult {
  apiKey: string;
  entitlement: Entitlement;
}

export interface ManagedAuthDeps {
  /** 缺省走 chrome.identity.launchWebAuthFlow（MV3 返回 Promise<string> redirectURL）。 */
  launchWebAuthFlow?: (opts: { url: string; interactive: boolean }) => Promise<string>;
  /** 缺省走 chrome.identity.getRedirectURL()（https://<EXTENSION_ID>.chromiumapp.org/）。 */
  getRedirectURL?: () => string;
  fetchFn?: typeof fetch;
  /** exchange 的本地化语言，缺省取当前 UI locale（getLocale()）。 */
  locale?: string;
}

/**
 * Google 一键登录 → 兑换长效 virtual key。
 * redirect_uri 在 start 与 exchange 两处必须完全一致（含尾斜杠）。
 * 幂等：同一 Google 账号重复登录返回同一把 key（后端保证），中途放弃可安全重登。
 */
export async function startManagedLogin(deps: ManagedAuthDeps = {}): Promise<LoginResult> {
  const launch =
    deps.launchWebAuthFlow ??
    ((opts) => chrome.identity.launchWebAuthFlow(opts) as unknown as Promise<string>);
  const getRedirectURL = deps.getRedirectURL ?? (() => chrome.identity.getRedirectURL());
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();

  const redirectUri = getRedirectURL();
  const authUrl = `${ACCOUNT_BASE}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const resultUrl = await launch({ url: authUrl, interactive: true });
  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) throw new Error("Login cancelled or not authorized");

  const resp = await fetchFn(`${ACCOUNT_BASE}/auth/exchange?locale=${encodeURIComponent(locale)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!resp.ok) throw new Error(`Login exchange failed (${resp.status})`);
  return finishLogin(await resp.json());
}

/** 登录成功收尾：归一化 entitlement → 回填缓存 → 落盘账号（登录即登录，不等订阅）。 */
async function finishLogin(raw: unknown): Promise<LoginResult> {
  // 归一化 entitlement：与 getEntitlement 同一道防线，护住喂 UI（含首月半价徽标）的主路径，
  // 不让 /auth/exchange 的畸形字段（如 introOffer.percentOff）裸穿到渲染层。
  const json = (raw ?? {}) as { apiKey?: unknown; entitlement?: unknown };
  const result: LoginResult = {
    apiKey: String(json.apiKey ?? ""),
    entitlement: normalizeEntitlement(json.entitlement),
  };
  if (result.apiKey) {
    await cacheEntitlement(result.apiKey, result.entitlement);
    await savePieAccount(result);
  }
  return result;
}

/** 邮箱验证码流程的失败：携带后端 error code（invalid_email / invalid_code /
 *  code_expired / too_many_attempts / mail_send_failed）。 */
export class EmailCodeError extends Error {
  constructor(
    public code: string,
    public status: number,
    /** 429 时的建议等待秒数（后端 retryAfter）。 */
    public retryAfter?: number,
  ) {
    super(code);
    this.name = "EmailCodeError";
  }
}

async function postEmailAuth(
  path: "/auth/email/start" | "/auth/email/verify",
  body: Record<string, string>,
  deps: ManagedAuthDeps,
  fallbackCode: string,
): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(`${ACCOUNT_BASE}${path}?locale=${encodeURIComponent(locale)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let code = fallbackCode;
    let retryAfter: number | undefined;
    try {
      const b = (await resp.json()) as { error?: unknown; retryAfter?: unknown };
      if (typeof b?.error === "string") code = b.error;
      if (typeof b?.retryAfter === "number") retryAfter = b.retryAfter;
    } catch {
      /* 非 JSON 错误体：保留 fallbackCode */
    }
    throw new EmailCodeError(code, resp.status, retryAfter);
  }
  return resp.json();
}

/** 发送 6 位邮箱验证码（新老邮箱响应一致，不泄露是否已注册）。 */
export async function sendEmailCode(email: string, deps: ManagedAuthDeps = {}): Promise<void> {
  await postEmailAuth("/auth/email/start", { email }, deps, "mail_send_failed");
}

/** 校验邮箱验证码 → 与 Google 登录同型的 LoginResult（同一账号同一把 key）。 */
export async function verifyEmailCode(
  email: string,
  code: string,
  deps: ManagedAuthDeps = {},
): Promise<LoginResult> {
  return finishLogin(await postEmailAuth("/auth/email/verify", { email, code }, deps, "invalid_code"));
}
