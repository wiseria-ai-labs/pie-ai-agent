// Pie 账号登录表单（Google 一键 / 邮箱验证码）。两种方式同屏，成功后都走
// managed-auth 的同一收尾（缓存 entitlement + 落盘账号）。
import { useEffect, useState } from "react";
import {
  EmailCodeError,
  sendEmailCode,
  startManagedLogin,
  verifyEmailCode,
  type LoginResult,
} from "@/lib/managed-auth";
import { useI18n, type DictKey } from "@/lib/i18n";
import { Button } from "./ui/Button";
import { GoogleGlyph } from "./icons";

export interface PieLoginDeps {
  login?: () => Promise<LoginResult>;
  sendCode?: (email: string) => Promise<void>;
  verifyCode?: (email: string, code: string) => Promise<LoginResult>;
}

/** 重发倒计时秒数（与后端同邮箱 60s 发送间隔对齐）。 */
const RESEND_SECONDS = 60;
const CODE_LENGTH = 6;

function errorMessage(e: unknown, t: (k: DictKey, p?: Record<string, string | number>) => string): string {
  if (e instanceof EmailCodeError) {
    switch (e.code) {
      case "invalid_email":
        return t("managed.login.errInvalidEmail");
      case "invalid_code":
        return t("managed.login.errInvalidCode");
      case "code_expired":
        return t("managed.login.errCodeExpired");
      case "too_many_attempts":
        return t("managed.login.errTooManyAttempts", { seconds: e.retryAfter ?? RESEND_SECONDS });
      case "mail_send_failed":
        return t("managed.login.errMailSendFailed");
    }
  }
  return t("managed.login.errGeneric");
}

export default function PieLoginForm({
  deps,
  onLoggedIn,
}: {
  deps?: PieLoginDeps;
  onLoggedIn: (res: LoginResult) => void;
}) {
  const { t } = useI18n();
  const login = deps?.login ?? (() => startManagedLogin());
  const sendCode = deps?.sendCode ?? ((email: string) => sendEmailCode(email));
  const verifyCode = deps?.verifyCode ?? ((email: string, code: string) => verifyEmailCode(email, code));

  // 哪条动作在飞（三个入口共用一个表单，各自只点亮自己的 spinner）。
  const [pending, setPending] = useState<null | "google" | "send" | "verify">(null);
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function handleGoogle() {
    if (pending) return;
    setPending("google");
    setError(null);
    try {
      onLoggedIn(await login());
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t("managed.login.errGeneric"));
    } finally {
      setPending(null);
    }
  }

  async function handleSend() {
    if (pending) return;
    setPending("send");
    setError(null);
    try {
      await sendCode(email.trim());
      setStage("code");
      setCode("");
      setCooldown(RESEND_SECONDS);
    } catch (e) {
      setError(errorMessage(e, t));
      const retryAfter = e instanceof EmailCodeError ? e.retryAfter : undefined;
      if (retryAfter) setCooldown(retryAfter);
    } finally {
      setPending(null);
    }
  }

  async function handleVerify(nextCode = code) {
    if (pending || nextCode.length !== CODE_LENGTH) return;
    setPending("verify");
    setError(null);
    try {
      onLoggedIn(await verifyCode(email.trim(), nextCode));
    } catch (e) {
      setError(errorMessage(e, t));
      setCode("");
      const retryAfter = e instanceof EmailCodeError ? e.retryAfter : undefined;
      if (retryAfter) setCooldown(retryAfter);
    } finally {
      setPending(null);
    }
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    // 满 6 位自动提交——验证码没有「值得再看一眼」的内容。
    if (digits.length === CODE_LENGTH) void handleVerify(digits);
  }

  const inputClass =
    "h-9 rounded-control border border-line bg-field px-3 text-[13px] text-fg-1 placeholder:text-fg-3 focus:border-accent";

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <Button variant="primary" size="md" fullWidth loading={pending === "google"} onClick={handleGoogle} iconLeft={<GoogleGlyph />}>
        {t("managed.subscribe.signInButton")}
      </Button>

      <div className="flex items-center gap-2 text-[11px] text-fg-3">
        <span className="h-px flex-1 bg-line" />
        {t("managed.login.or")}
        <span className="h-px flex-1 bg-line" />
      </div>

      {stage === "email" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <input
            type="email"
            required
            autoComplete="email"
            data-testid="login-email"
            aria-label={t("managed.login.emailLabel")}
            placeholder={t("managed.login.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <Button type="submit" size="md" fullWidth loading={pending === "send"} disabled={!email.trim()}>
            {t("managed.login.sendCode")}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleVerify();
          }}
        >
          <div className="flex items-center gap-1.5 text-[12px] text-fg-2">
            <span className="min-w-0 flex-1 truncate">{t("managed.login.codeSentTo", { email })}</span>
            <button
              type="button"
              data-testid="login-change-email"
              onClick={() => {
                setStage("email");
                setCode("");
                setError(null);
              }}
              className="shrink-0 text-accent hover:underline"
            >
              {t("managed.login.changeEmail")}
            </button>
          </div>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            data-testid="login-code"
            aria-label={t("managed.login.codeLabel")}
            placeholder="••••••"
            maxLength={CODE_LENGTH}
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            className={`${inputClass} text-center font-mono text-[16px] tracking-[0.4em]`}
          />
          <Button type="submit" size="md" fullWidth loading={pending === "verify"} disabled={code.length !== CODE_LENGTH}>
            {t("managed.login.verify")}
          </Button>
          <button
            type="button"
            disabled={cooldown > 0}
            onClick={() => {
              void handleSend();
            }}
            className="self-center text-[12px] text-fg-2 hover:text-fg-1 disabled:opacity-50 disabled:pointer-events-none"
          >
            {cooldown > 0 ? t("managed.login.resendIn", { seconds: cooldown }) : t("managed.login.resend")}
          </button>
        </form>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning"
        >
          {error}
        </div>
      )}
    </div>
  );
}
