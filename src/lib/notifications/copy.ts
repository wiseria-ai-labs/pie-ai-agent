// src/lib/notifications/copy.ts
//
// SW-side notification/highlight copy — a SMALL table (not the panel's six full
// dictionaries). The service worker resolves the user's UI locale and picks a
// row; unknown locales fall back to English.
//
// Why not reuse src/lib/i18n/dictionaries: those carry every panel string (6 ×
// ~950 lines). Pulling them into the SW bundle to render four notifications is
// not worth the weight, and the SW has no React/i18n provider. This table is
// the entire SW-visible copy surface: keep it small, keep it parity-tested.
//
// Ordering rule: a notification's title is user/page data plus a localized
// frame; never interpolate untrusted page text into anything but a value slot.

import { resolveLocale } from "@/lib/i18n/locale-resolver";
import type { Locale } from "@/lib/i18n/types";

export type NotifyKey =
  // Page monitors (§4.5)
  | "monitor.button.openPage"
  | "monitor.button.stop"
  | "monitor.paused.title"
  | "monitor.paused.body"
  | "monitor.reason.login"
  | "monitor.reason.not_found"
  | "monitor.reason.blocked"
  | "monitor.reason.network"
  | "monitor.reason.user"
  // F9 — the dashed box label painted onto the page
  | "monitor.highlight.label"
  // Scheduled runs (existing notifications, now localized)
  | "schedule.run.successTitle"
  | "schedule.run.failTitle"
  | "schedule.run.doneFallback"
  | "schedule.run.failFallback"
  | "schedule.paused.title"
  | "schedule.paused.body"
  | "schedule.completed.title"
  | "schedule.completed.body"
  | "schedule.instanceDeleted.title"
  | "schedule.instanceDeleted.body";

type Table = Record<NotifyKey, string>;

const EN: Table = {
  "monitor.button.openPage": "Open page",
  "monitor.button.stop": "Stop monitoring",
  "monitor.paused.title": "{title} — paused",
  "monitor.paused.body": "Paused after {count} failed checks ({reason}).",
  "monitor.reason.login": "sign-in required",
  "monitor.reason.not_found": "target not found",
  "monitor.reason.blocked": "blocked by the site",
  "monitor.reason.network": "network error",
  "monitor.reason.user": "paused by you",
  "monitor.highlight.label": "Pie will watch this",
  "schedule.run.successTitle": "✓ {title}",
  "schedule.run.failTitle": "✗ {title} — failed",
  "schedule.run.doneFallback": "Run completed.",
  "schedule.run.failFallback": "Run failed.",
  "schedule.paused.title": "Schedule paused: {title}",
  "schedule.paused.body":
    "Auto-paused after {count} consecutive failures. Re-enable it in Automation.",
  "schedule.completed.title": "Schedule completed: {title}",
  "schedule.completed.body": "Finished all {count} scheduled runs.",
  "schedule.instanceDeleted.title": "Schedule paused: {title}",
  "schedule.instanceDeleted.body": "The bound AI provider was removed. Re-enable it in Automation.",
};

const ZH_CN: Table = {
  "monitor.button.openPage": "打开页面",
  "monitor.button.stop": "停止监控",
  "monitor.paused.title": "{title} — 已暂停",
  "monitor.paused.body": "连续 {count} 次检查失败（{reason}），已暂停这条监控。",
  "monitor.reason.login": "需要登录",
  "monitor.reason.not_found": "找不到目标",
  "monitor.reason.blocked": "被站点拦截",
  "monitor.reason.network": "网络错误",
  "monitor.reason.user": "你手动暂停",
  "monitor.highlight.label": "Pie 会盯住这里",
  "schedule.run.successTitle": "✓ {title}",
  "schedule.run.failTitle": "✗ {title} — 失败",
  "schedule.run.doneFallback": "已完成。",
  "schedule.run.failFallback": "运行失败。",
  "schedule.paused.title": "定时任务已暂停：{title}",
  "schedule.paused.body": "连续 {count} 次失败后自动暂停。可在「自动化」里重新启用。",
  "schedule.completed.title": "定时任务已完成：{title}",
  "schedule.completed.body": "已跑完安排的全部 {count} 次。",
  "schedule.instanceDeleted.title": "定时任务已暂停：{title}",
  "schedule.instanceDeleted.body": "绑定的 AI 服务已被删除。可在「自动化」里重新启用。",
};

const ZH_TW: Table = {
  "monitor.button.openPage": "開啟頁面",
  "monitor.button.stop": "停止監控",
  "monitor.paused.title": "{title} — 已暫停",
  "monitor.paused.body": "連續 {count} 次檢查失敗（{reason}），已暫停這條監控。",
  "monitor.reason.login": "需要登入",
  "monitor.reason.not_found": "找不到目標",
  "monitor.reason.blocked": "被網站阻擋",
  "monitor.reason.network": "網路錯誤",
  "monitor.reason.user": "你手動暫停",
  "monitor.highlight.label": "Pie 會盯著這裡",
  "schedule.run.successTitle": "✓ {title}",
  "schedule.run.failTitle": "✗ {title} — 失敗",
  "schedule.run.doneFallback": "已完成。",
  "schedule.run.failFallback": "執行失敗。",
  "schedule.paused.title": "定時任務已暫停：{title}",
  "schedule.paused.body": "連續 {count} 次失敗後自動暫停。可在「自動化」裡重新啟用。",
  "schedule.completed.title": "定時任務已完成：{title}",
  "schedule.completed.body": "已跑完安排的全部 {count} 次。",
  "schedule.instanceDeleted.title": "定時任務已暫停：{title}",
  "schedule.instanceDeleted.body": "綁定的 AI 服務已被刪除。可在「自動化」裡重新啟用。",
};

const JA: Table = {
  "monitor.button.openPage": "ページを開く",
  "monitor.button.stop": "監視を停止",
  "monitor.paused.title": "{title} — 一時停止",
  "monitor.paused.body": "{count} 回連続で失敗したため一時停止しました（{reason}）。",
  "monitor.reason.login": "ログインが必要",
  "monitor.reason.not_found": "対象が見つからない",
  "monitor.reason.blocked": "サイトにブロックされた",
  "monitor.reason.network": "ネットワークエラー",
  "monitor.reason.user": "手動で停止",
  "monitor.highlight.label": "Pie はここを監視します",
  "schedule.run.successTitle": "✓ {title}",
  "schedule.run.failTitle": "✗ {title} — 失敗",
  "schedule.run.doneFallback": "実行が完了しました。",
  "schedule.run.failFallback": "実行に失敗しました。",
  "schedule.paused.title": "スケジュールを一時停止：{title}",
  "schedule.paused.body": "{count} 回連続で失敗したため自動停止しました。「自動化」から再開できます。",
  "schedule.completed.title": "スケジュール完了：{title}",
  "schedule.completed.body": "予定された {count} 回をすべて実行しました。",
  "schedule.instanceDeleted.title": "スケジュールを一時停止：{title}",
  "schedule.instanceDeleted.body": "紐付けられた AI プロバイダーが削除されました。「自動化」から再開できます。",
};

const ES_419: Table = {
  "monitor.button.openPage": "Abrir página",
  "monitor.button.stop": "Detener monitoreo",
  "monitor.paused.title": "{title} — en pausa",
  "monitor.paused.body": "En pausa tras {count} comprobaciones fallidas ({reason}).",
  "monitor.reason.login": "requiere iniciar sesión",
  "monitor.reason.not_found": "objetivo no encontrado",
  "monitor.reason.blocked": "bloqueado por el sitio",
  "monitor.reason.network": "error de red",
  "monitor.reason.user": "pausado por ti",
  "monitor.highlight.label": "Pie vigilará esto",
  "schedule.run.successTitle": "✓ {title}",
  "schedule.run.failTitle": "✗ {title} — falló",
  "schedule.run.doneFallback": "Ejecución completada.",
  "schedule.run.failFallback": "La ejecución falló.",
  "schedule.paused.title": "Tarea programada en pausa: {title}",
  "schedule.paused.body":
    "Se pausó tras {count} fallos consecutivos. Puedes reactivarla en Automatización.",
  "schedule.completed.title": "Tarea programada completada: {title}",
  "schedule.completed.body": "Terminó las {count} ejecuciones programadas.",
  "schedule.instanceDeleted.title": "Tarea programada en pausa: {title}",
  "schedule.instanceDeleted.body":
    "Se eliminó el proveedor de IA asociado. Puedes reactivarla en Automatización.",
};

const PT_BR: Table = {
  "monitor.button.openPage": "Abrir página",
  "monitor.button.stop": "Parar monitoramento",
  "monitor.paused.title": "{title} — pausado",
  "monitor.paused.body": "Pausado após {count} verificações com falha ({reason}).",
  "monitor.reason.login": "precisa de login",
  "monitor.reason.not_found": "alvo não encontrado",
  "monitor.reason.blocked": "bloqueado pelo site",
  "monitor.reason.network": "erro de rede",
  "monitor.reason.user": "pausado por você",
  "monitor.highlight.label": "O Pie vai vigiar isto",
  "schedule.run.successTitle": "✓ {title}",
  "schedule.run.failTitle": "✗ {title} — falhou",
  "schedule.run.doneFallback": "Execução concluída.",
  "schedule.run.failFallback": "A execução falhou.",
  "schedule.paused.title": "Tarefa agendada em pausa: {title}",
  "schedule.paused.body":
    "Pausada após {count} falhas consecutivas. Você pode reativá-la em Automação.",
  "schedule.completed.title": "Tarefa agendada concluída: {title}",
  "schedule.completed.body": "Concluiu as {count} execuções agendadas.",
  "schedule.instanceDeleted.title": "Tarefa agendada em pausa: {title}",
  "schedule.instanceDeleted.body":
    "O provedor de IA vinculado foi removido. Você pode reativá-la em Automação.",
};

export const NOTIFY_TABLES: Record<Locale, Table> = {
  en: EN,
  "zh-CN": ZH_CN,
  "zh-TW": ZH_TW,
  ja: JA,
  "es-419": ES_419,
  "pt-BR": PT_BR,
};

/** Test-only: the English table (key set authority). */
export const EN_NOTIFY_TABLE = EN;

function substitute(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  );
}

/**
 * Resolved-locale cache. A burst (e.g. deleting an instance pauses ten
 * schedules) would otherwise do ten IDB reads; a 30 s TTL still picks up a
 * locale change made in Settings without needing a store-bus subscription here.
 */
const LOCALE_TTL_MS = 30_000;
let localeCache: { locale: Locale; at: number } | null = null;

/** Test-only: drop the cache. */
export function __resetNotifLocaleCache(): void {
  localeCache = null;
}

async function currentLocale(): Promise<Locale> {
  const now = Date.now();
  if (localeCache && now - localeCache.at < LOCALE_TTL_MS) return localeCache.locale;
  let locale: Locale = "en";
  try {
    locale = await resolveLocale();
  } catch {
    // No chrome.i18n / no config in this context (tests, early boot) → English.
  }
  localeCache = { locale, at: now };
  return locale;
}

/** Localized SW copy, resolved against the user's UI-locale setting. */
export async function notifT(
  key: NotifyKey,
  params?: Record<string, string | number>,
): Promise<string> {
  const locale = await currentLocale();
  const table = NOTIFY_TABLES[locale] ?? EN;
  return substitute(table[key] ?? EN[key] ?? key, params);
}
