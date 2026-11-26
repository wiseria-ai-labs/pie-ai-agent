// 账号二级页：未登录 → PieLoginForm；已登录 → 复用 ManagedAccountPanel
// （plan none 时它内部已内嵌订阅引导）+ 底部退出登录。
import { useCallback, useEffect, useState } from "react";
import { getPieAccount, signOutPieAccount, type PieAccount } from "@/lib/pie-account";
import { useI18n } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import type { LoginResult } from "@/lib/managed-auth";
import ManagedAccountPanel from "../../ManagedAccountPanel";
import { ManagedPlanIcon } from "../../ManagedPlanIcon";
import PieLoginForm from "../../PieLoginForm";
import HolidayPromoBanner from "../../HolidayPromoBanner";
import { HOLIDAY_SALE_CODE, isHolidaySaleActive } from "@/lib/holiday-sale";

export default function AccountPage({
  __loginDeps,
}: {
  /** Test-only injection for the login form. */
  __loginDeps?: import("../../PieLoginForm").PieLoginDeps;
} = {}) {
  const { t } = useI18n();
  // undefined = 首次读取中（避免未登录表单闪一下）
  const [account, setAccount] = useState<PieAccount | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void getPieAccount()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  useEffect(() => {
    reload();
    // 别处（深链开面板 / 后台）改了实例列表也跟上。
    return onStoreChange("instances", reload);
  }, [reload]);

  function onLoggedIn(_res: LoginResult) {
    setError(null);
    reload();
  }

  async function handleSignOut() {
    if (busy) return;
    if (!confirm(t("settings.account.signOutConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await signOutPieAccount();
      reload();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t("settings.account.signOutFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (account === undefined) {
    return <div className="text-[13px] text-fg-3">{t("managed.account.loading")}</div>;
  }

  if (!account) {
    return (
      <div className="flex flex-col gap-4 text-[13px]">
        <div className="flex items-center gap-3">
          <ManagedPlanIcon size={36} className="shrink-0" />
          <div className="flex flex-col gap-0.5">
            <div className="text-[14px] font-medium text-fg-1">{t("managed.subscribe.signInTitle")}</div>
            <div className="font-mono text-[11px] text-fg-3">{t("managed.subscribe.signInCaption")}</div>
          </div>
        </div>
        <p className="leading-[19px] text-fg-2">{t("managed.subscribe.signInBody")}</p>
        {isHolidaySaleActive() && (
          <HolidayPromoBanner
            variant="compact"
            testId="holiday-account-banner"
            description={t("holidaySale.accountSignInDesc", { code: HOLIDAY_SALE_CODE })}
            showDetailsLink
          />
        )}
        <PieLoginForm deps={__loginDeps} onLoggedIn={onLoggedIn} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ManagedAccountPanel apiKey={account.apiKey} />
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <button
          type="button"
          data-testid="account-sign-out"
          disabled={busy}
          onClick={() => void handleSignOut()}
          className="self-start text-[13px] text-warning transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {t("settings.account.signOut")}
        </button>
        <p className="text-[11px] leading-[16px] text-fg-3">{t("settings.account.signOutNote")}</p>
        {error && (
          <div role="alert" className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
