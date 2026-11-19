// src/lib/memory/history-source.ts
//
// 记忆来源二：浏览历史（spec §5.3 / S4）。
//
// 隐私边界：
//   - 默认关；打开要 history 可选权限，授权走书签历史线已有的
//     `browser-data/permissions.ts`（面板点击时用 grantBrowserDataPermission）。
//   - 只读「网站 + 标题」，**不读网页内容、不读 URL 的路径与查询串**。
//   - Chrome 历史没有停留时长——这里只聚合「访问次数 + 最近访问时间」。
//   - 标题是第三方数据：进 prompt 前由 prompt.ts 包进 <untrusted_history_entry>。

import { hasBrowserDataPermission } from "@/lib/browser-data/permissions";
import { searchHistory, type HistoryEntry } from "@/lib/browser-data/history";

/** 每次整理回看的窗口。 */
export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 交给模型的站点数上限（按访问次数排序）。 */
export const HISTORY_MAX_SITES = 40;
/** 每个站点带几条例标题（去重后）。 */
export const HISTORY_TITLES_PER_SITE = 3;
/** searchHistory 的单次上限（其 public cap 是 50）。 */
const HISTORY_QUERY_LIMIT = 50;

export interface HistorySiteSummary {
  host: string;
  /** 窗口内该站点所有条目的访问次数之和。 */
  visits: number;
  /** 最近一次访问（epoch ms）。 */
  lastVisit: number;
  /** 去重后的页面标题，最多 HISTORY_TITLES_PER_SITE 条（原始文本，渲染时转义）。 */
  titles: string[];
}

export function hostOfUrl(url: string): string {
  try {
    const u = new URL(url);
    // 只认 http(s)：chrome:// / file:// / 扩展页不是「网站」，也不该进记忆。
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 把历史条目聚合成「常用网站」。纯函数：排序按访问次数降序，其次最近访问。
 * 没有 host 的条目（chrome://、本地文件、坏 URL）直接丢掉。
 */
export function summarizeHistory(
  entries: readonly Pick<HistoryEntry, "url" | "title" | "lastVisitTime" | "visitCount">[],
  opts: { maxSites?: number; titlesPerSite?: number } = {},
): HistorySiteSummary[] {
  const maxSites = opts.maxSites ?? HISTORY_MAX_SITES;
  const titlesPerSite = opts.titlesPerSite ?? HISTORY_TITLES_PER_SITE;
  const byHost = new Map<string, HistorySiteSummary>();

  for (const e of entries) {
    const host = hostOfUrl(e.url);
    if (!host) continue;
    const cur = byHost.get(host) ?? { host, visits: 0, lastVisit: 0, titles: [] };
    cur.visits += Math.max(1, e.visitCount || 1);
    cur.lastVisit = Math.max(cur.lastVisit, e.lastVisitTime || 0);
    const title = (e.title ?? "").trim();
    if (title && !cur.titles.includes(title) && cur.titles.length < titlesPerSite) {
      cur.titles.push(title);
    }
    byHost.set(host, cur);
  }

  return [...byHost.values()]
    .sort((a, b) => b.visits - a.visits || b.lastVisit - a.lastVisit)
    .slice(0, maxSites);
}

/**
 * 读一窗口的浏览历史并聚合。没权限 / 读失败返回 null（记忆层静默降级）。
 * 依赖可注入，便于测试；权限一律走 browser-data 线的 helper。
 */
export async function readHistoryForMemory(
  now = Date.now(),
  deps: {
    hasPermission?: (domain: "history") => Promise<boolean>;
    search?: typeof searchHistory;
    windowMs?: number;
    maxSites?: number;
  } = {},
): Promise<HistorySiteSummary[] | null> {
  const hasPermission = deps.hasPermission ?? hasBrowserDataPermission;
  const search = deps.search ?? searchHistory;
  try {
    if (!(await hasPermission("history"))) return null;
    const res = await search({
      from: now - (deps.windowMs ?? HISTORY_WINDOW_MS),
      to: now,
      limit: HISTORY_QUERY_LIMIT,
    });
    if (!res.ok) return null;
    return summarizeHistory(res.entries, { maxSites: deps.maxSites ?? HISTORY_MAX_SITES });
  } catch {
    return null;
  }
}
