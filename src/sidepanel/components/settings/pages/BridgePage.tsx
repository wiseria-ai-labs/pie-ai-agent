import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { Switch } from "../../ui/Switch";
import { AgentBrandIcon } from "../../hitl/agent-brand-icons";
import { queryBridgeStatus, type BridgeStatus } from "../bridge-status";
import { groupAgentsByBrand, inferFormKind } from "@/lib/local-agents-prefs";
import { isAllowlistedExtId } from "@/lib/extension-ids";

// Pie Link 安装包稳定 URL（release latest）——升级卡下载按钮直链（升级用户已知 Pie Link 是什么，直链摩擦最小）。
// #403：按平台分流——macOS 下 .pkg、Windows 下 setup.exe。旧代码只有 mac .pkg，Windows 用户点
// 升级卡会下到错的包。两个都是 /releases/latest/download/ 稳定别名（release.yml 上传固定名 asset）。
const MAC_PKG_URL = "https://github.com/wiseria-ai-labs/pie-ai-agent/releases/latest/download/pie-link.pkg";
const WIN_SETUP_URL = "https://github.com/wiseria-ai-labs/pie-ai-agent/releases/latest/download/pie-link-setup.exe";
// 运行平台判定（同步，够用）：Windows 走 setup.exe，其余（mac）走 pkg。
const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const INSTALLER_URL = IS_WINDOWS ? WIN_SETUP_URL : MAC_PKG_URL;
// 官网 Pie Link 介绍页（介绍 + 下载 + 卸载说明）——首次安装卡跳这里，给首装用户上下文。
const LINK_URL = "https://www.pie.chat/link";

// 首连排障引导（#328）：连续失败超过此阈值就追加「首次安装需要重启」排障块。人工拍板
// （见 PR #329 review）把阈值从 5 降到 1——首次连接失败即提示，不再等退避梯子跑 ~1 分钟。
// 该块只在「开关开着 && 没连上」时出现，首次失败即提示不算打扰。SW 侧的失败计数 /
// lastDisconnectError 留存 / console.warn 证据链保留不动（钉根因仍需要）。
const TROUBLESHOOT_THRESHOLD = 1;

type PanelAgent = { id: string; label: string; installed: boolean; enabled: boolean; kind?: "app" | "terminal" };

type BrandRow = {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  chips: string[];
};

function toBrandRows(agents: PanelAgent[]): BrandRow[] {
  return groupAgentsByBrand(agents).map((b) => {
    const installedForms = b.forms.filter((f) => f.installed);
    const hasKind = b.forms.some((f) => f.kind);
    return {
      id: b.id,
      name: !hasKind && b.forms.length === 1 ? b.forms[0].label : b.label,
      enabled: b.forms.some((f) => f.enabled && f.installed),
      installed: installedForms.length > 0,
      chips: hasKind
        ? installedForms.map((f) => (inferFormKind(f.id, f.kind) === "app" ? "App" : "Terminal"))
        : [],
    };
  });
}

// Settings「本地 Agent」列表 — 一次性查询，无轮询（挂载/桥就绪/开关交互后各触发一次）。
function queryLocalAgents(cb: (agents: PanelAgent[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-agents:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.agents)) cb(res.agents as PanelAgent[]);
    });
  } catch {
    /* noop */
  }
}

// 本地打通开关 + 实时状态。开=请求 nativeMessaging（用户手势）→ SW onAdded 连桥；
// 关=移除权限 → SW onRemoved 断桥。挂载期每 1.5s 轮询一次状态（连接是异步的）。

export function LocalBridgeSection() {
  const t = useT();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [agents, setAgents] = useState<PanelAgent[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [view, setView] = useState<"main" | "agents">("main");

  useEffect(() => {
    queryBridgeStatus(setStatus);
    const id = setInterval(() => queryBridgeStatus(setStatus), 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status?.ready) queryLocalAgents(setAgents);
    else {
      setAgents([]);
      setView("main"); // 桥断开 → 管理子视图失去意义，强制回主视图
    }
  }, [status?.ready]);

  const enabled = status?.hasPermission ?? false;
  const onToggle = async (next: boolean) => {
    try {
      if (next) await chrome.permissions.request({ permissions: ["nativeMessaging"] });
      else await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
    } catch {
      /* 用户取消了权限弹窗 */
    }
    queryBridgeStatus(setStatus);
  };

  // 安装卡「重新检测」：让 SW 立即重连（重置退避 + 重新握手），随后立即再查一次状态。
  const onRecheck = () => {
    try {
      chrome.runtime.sendMessage({ type: "local-bridge:reconnect" }, () => {
        if (chrome.runtime.lastError) return;
        queryBridgeStatus(setStatus);
      });
    } catch {
      /* noop */
    }
  };

  // 排障引导「重启扩展」：直接 chrome.runtime.reload()，替用户做掉 chrome://extensions
  // 手动刷新那步。会关闭侧栏（文案已提示需重新打开）。
  const onRestartExtension = () => {
    try {
      chrome.runtime.reload();
    } catch {
      /* noop */
    }
  };

  const onAgentToggle = (id: string, next: boolean) => {
    setFailedId(null);
    try {
      chrome.runtime.sendMessage({ type: "local-agents:toggle", id, next }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryLocalAgents(setAgents);
        else setFailedId(id);
      });
    } catch {
      /* noop */
    }
  };

  // protocolMismatch 是 not-ready 状态（见 local-bridge.ts 握手），不能被 ready 门住；
  // 只有软升级（needsUpgrade）要求已连上（ready）。
  const showUpgrade = !!status?.protocolMismatch || (!!status?.ready && !!status.needsUpgrade);

  // 安装引导漏斗（Slice 4）：开关开、未连、且不是升级态时，按 SW 分类的 installState
  // 呈现——未安装 → 安装卡；已装未连 → doctor 引导。unknown / undefined（旧 SW）落回
  // 现有「未连接」文案（向后兼容）。
  const installState = status?.installState;
  const notReadyEnabled = enabled && status != null && !status.ready && !showUpgrade;
  // Path-derived unpacked id (Edge `-edge.zip` without `key`) is not in
  // Pie Link `allowed_origins`. Don't send those users down the "install
  // Pie Link" funnel — the host is fine, the package is wrong.
  const extId = typeof chrome !== "undefined" ? chrome.runtime?.id : undefined;
  const showWrongExtIdHint = notReadyEnabled && !!extId && !isAllowlistedExtId(extId);
  const showInstallCard = notReadyEnabled && installState === "not_installed" && !showWrongExtIdHint;
  const showDoctorHint = notReadyEnabled && installState === "installed_not_running" && !showWrongExtIdHint;
  // 首连排障块（#328）：开关开、未连、非升级态、且已有连接失败时，在安装卡/doctor 卡下
  // 追加。直给「首次安装需要重启扩展」引导——覆盖「装了、跑了、Chrome 就是连不上」这条
  // 既有卡片没覆盖的失败叙事。旧 SW 不回 failedAttempts → ?? 0 → 不出现（向后兼容）。
  const showTroubleshoot = notReadyEnabled && (status?.failedAttempts ?? 0) >= TROUBLESHOOT_THRESHOLD;

  const statusText =
    status == null
      ? ""
      : !status.hasPermission
        ? t("settings.localBridge.statusOff")
        : status.ready
          ? t("settings.localBridge.statusConnected") +
            (status.daemonVersion ? ` · Pie Link v${status.daemonVersion}` : "")
          : // protocol 硬不兼容时握手不置 ready（ready===false 与 protocolMismatch===true
            // 互斥），单独给强状态文案，别让它落到普通「未连接」。
            status.protocolMismatch
            ? t("settings.localBridge.statusIncompatible")
            : // 未装/已装未连由下方专用卡片承载文案，状态行留空避免重复。
              showInstallCard || showDoctorHint || showWrongExtIdHint
              ? ""
              : t("settings.localBridge.statusEnabledNotConnected");

  const brandRows = useMemo(() => toBrandRows(agents), [agents]);
  const enabledBrands = brandRows.filter((b) => b.enabled);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {t("settings.localBridge.sectionTitle")}
        </span>
      </div>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
        {view === "main" ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.title")}</div>
                <div className="text-[12px] leading-relaxed text-fg-3">{t("settings.localBridge.description")}</div>
                {statusText && (
                  <div className="flex items-center gap-1.5">
                    {status?.ready && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
                    <span className={`text-[12px] ${status?.ready ? "text-fg-1" : "text-fg-3"}`}>{statusText}</span>
                  </div>
                )}
              </div>
              <Switch checked={enabled} onChange={onToggle} />
            </div>
            {showUpgrade && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[12px] leading-relaxed text-fg-2">
                  {status?.protocolMismatch
                    ? t("settings.localBridge.upgradeRequired")
                    : t("settings.localBridge.upgradeAvailable")}
                </div>
                <a
                  href={INSTALLER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.downloadUpdate")}
                </a>
                {/* macOS：装过这一次新版后，此后更新一键走顶栏 Pie 图标（零提权、零密码，#403）。
                    Windows 侧 UAC 省不掉，仍走下载安装器，故不显示此提示。 */}
                {!IS_WINDOWS && (
                  <div className="text-[11px] leading-relaxed text-fg-3">
                    {t("settings.localBridge.upgradeMenubarHint")}
                  </div>
                )}
              </div>
            )}
            {showWrongExtIdHint && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[13px] font-medium text-fg-1">
                  {t("settings.localBridge.wrongExtIdTitle")}
                </div>
                <div className="text-[12px] leading-relaxed text-fg-2">
                  {t("settings.localBridge.wrongExtIdBody")}
                </div>
              </div>
            )}
            {showInstallCard && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.installTitle")}</div>
                <div className="text-[12px] leading-relaxed text-fg-2">{t("settings.localBridge.installBody")}</div>
                <div className="flex items-center gap-2">
                  <a
                    href={LINK_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                  >
                    {t("settings.localBridge.installDownload")}
                  </a>
                  <button
                    type="button"
                    onClick={onRecheck}
                    className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                  >
                    {t("settings.localBridge.recheck")}
                  </button>
                </div>
              </div>
            )}
            {showDoctorHint && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[12px] leading-relaxed text-fg-2">{t("settings.localBridge.doctorHint")}</div>
                <button
                  type="button"
                  onClick={onRecheck}
                  className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.recheck")}
                </button>
              </div>
            )}
            {showTroubleshoot && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[13px] font-medium text-fg-1">
                  {t("settings.localBridge.troubleshootTitle")}
                </div>
                <div className="text-[12px] leading-relaxed text-fg-2">
                  {t("settings.localBridge.troubleshootBody")}
                </div>
                <button
                  type="button"
                  onClick={onRestartExtension}
                  className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.troubleshootRestartExtension")}
                </button>
                <div className="text-[12px] leading-relaxed text-fg-3">
                  {t("settings.localBridge.troubleshootFallback")}
                </div>
              </div>
            )}
            {status?.ready && agents.length > 0 && (
              <div className="flex flex-col gap-2.5 border-t border-line pt-3">
                {enabledBrands.length > 0 && (
                  <>
                    <span className="caps text-fg-3">{t("settings.localBridge.agentsEnabledTitle")}</span>
                    {enabledBrands.map((b) => (
                      <div key={b.id} className="flex items-center gap-2.5">
                        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field text-fg-2">
                          <AgentBrandIcon agentId={b.id} size={14} />
                        </span>
                        <span className="text-[13px] text-fg-1">{b.name}</span>
                        {b.chips.length > 0 && (
                          <span className="text-[11px] text-fg-3">{b.chips.join(" · ")}</span>
                        )}
                      </div>
                    ))}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    queryLocalAgents(setAgents);
                    setView("agents");
                  }}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-[7px] text-[12px] font-medium text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.manageAgents")}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Back"
                onClick={() => setView("main")}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-2 hover:text-fg-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <span className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.manageAgents")}</span>
            </div>
            {brandRows.map((b) => {
              const subLine = [
                b.chips.join(" · ") || null,
                b.installed ? null : t("settings.localBridge.agentNotInstalled"),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div key={b.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field ${b.installed ? "text-fg-2" : "text-fg-3"}`}
                    >
                      <AgentBrandIcon agentId={b.id} size={14} />
                    </span>
                    <div className="flex grow flex-col">
                      <span className={`text-[13px] ${b.installed ? "text-fg-1" : "text-fg-2"}`}>{b.name}</span>
                      {subLine && <span className="text-[11px] text-fg-3">{subLine}</span>}
                    </div>
                    <Switch
                      checked={b.enabled}
                      onChange={(next) => {
                        if (!b.installed && next) return;
                        onAgentToggle(b.id, next);
                      }}
                    />
                  </div>
                  {failedId === b.id && (
                    <div className="text-[11px] text-fg-3">{t("settings.localBridge.agentEnableFailed")}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default function BridgePage() {
  return <LocalBridgeSection />;
}
