// Browsing-history layer (spec §3.2). Reads and deletes via chrome.history.
//
// Two product rules baked in here:
//   - Chrome history has NO dwell time. Entries carry title / url / last visit /
//     visit count only, and the tool layer says so — never "you read it for N
//     minutes".
//   - Deletion is irreversible and gets NO snapshot. chrome.history.addUrl can
//     re-add a URL, but not its original visit times — a fake restore is worse
//     than none (F8). Deletions are still logged so the settings page can show
//     "删除 N 条浏览记录 · 不可还原".

import type { HistoryDeletionRequest, HistoryDeletionSite } from "./types";
import { putChange } from "./changes";

export interface HistoryEntry {
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
}

export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on a single deletion card — a human must be able to read it. */
export const MAX_DELETE_ENTRIES = 2000;
export const MAX_SEARCH_RESULTS = 50;

function api(): typeof chrome.history | null {
  return typeof chrome !== "undefined" && chrome.history ? chrome.history : null;
}

/** Accept epoch ms or any Date-parsable string (local-time ISO included). */
export function coerceTime(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const ms = new Date(String(v)).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\.+/, "");
  return !!d && (host === d || host.endsWith(`.${d}`));
}

async function queryRange(from: number, to: number, text: string): Promise<HistoryEntry[]> {
  const h = api();
  if (!h) return [];
  const rows = await h.search({ text, startTime: from, endTime: to, maxResults: 10000 });
  return rows
    .filter((r) => !!r.url)
    .map((r) => ({
      url: r.url as string,
      title: r.title ?? "",
      lastVisitTime: r.lastVisitTime ?? 0,
      visitCount: r.visitCount ?? 0,
    }));
}

export async function searchHistory(opts: {
  query?: string;
  from?: unknown;
  to?: unknown;
  domain?: string;
  limit?: number;
}): Promise<
  | { ok: true; entries: HistoryEntry[]; total: number; truncated: boolean }
  | { ok: false; error: string }
> {
  const h = api();
  if (!h) return { ok: false, error: PERMISSION_ERROR };
  const to = coerceTime(opts.to) ?? Date.now();
  const from = coerceTime(opts.from) ?? to - DEFAULT_WINDOW_MS;
  if (from > to) return { ok: false, error: "`from` is after `to`" };

  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, opts.limit ?? 30));
  let rows = await queryRange(from, to, opts.query ?? "");
  if (opts.domain?.trim()) {
    rows = rows.filter((r) => domainMatches(hostOf(r.url), opts.domain!));
  }
  rows.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  return {
    ok: true,
    entries: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
  };
}

/** Collect the entries a deletion request would remove, plus the card payload. */
export async function proposeHistoryDeletion(opts: {
  urls?: unknown;
  domain?: string;
  from?: unknown;
  to?: unknown;
}): Promise<
  | { ok: true; request: HistoryDeletionRequest; urls: string[] }
  | { ok: false; error: string }
> {
  const h = api();
  if (!h) return { ok: false, error: PERMISSION_ERROR };

  const urls = Array.isArray(opts.urls)
    ? opts.urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  const domain = opts.domain?.trim() ?? "";
  const fromRaw = coerceTime(opts.from);
  const toRaw = coerceTime(opts.to);
  if (urls.length === 0 && !domain && fromRaw === undefined && toRaw === undefined) {
    return {
      ok: false,
      error:
        "refusing to delete without a filter — pass at least one of urls, domain, or a from/to range",
    };
  }

  const to = toRaw ?? Date.now();
  // Explicit URL list → the user named exact pages, so look across all time.
  // A bare `domain` keeps the 30-day default (the card prints the actual range).
  const from = fromRaw ?? (urls.length > 0 ? 0 : to - DEFAULT_WINDOW_MS);
  if (from > to) return { ok: false, error: "`from` is after `to`" };

  let rows = await queryRange(from, to, "");
  if (domain) rows = rows.filter((r) => domainMatches(hostOf(r.url), domain));
  if (urls.length > 0) {
    const wanted = new Set(urls);
    rows = rows.filter((r) => wanted.has(r.url));
  }
  if (rows.length === 0) return { ok: false, error: "no history entries match that filter" };

  const unique = [...new Map(rows.map((r) => [r.url, r])).values()];
  if (unique.length > MAX_DELETE_ENTRIES) {
    return {
      ok: false,
      error: `that filter matches ${unique.length} entries (cap ${MAX_DELETE_ENTRIES}) — narrow the range or add a domain`,
    };
  }

  const byDomain = new Map<string, number>();
  for (const r of unique) {
    const host = hostOf(r.url) || "(unknown)";
    byDomain.set(host, (byDomain.get(host) ?? 0) + 1);
  }
  const sites: HistoryDeletionSite[] = [...byDomain.entries()]
    .map(([d, count]) => ({ domain: d, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const actualFrom = Math.min(...unique.map((r) => r.lastVisitTime || from));
  const actualTo = Math.max(...unique.map((r) => r.lastVisitTime || to));

  // Structured only: the card renders count / range / sites through i18n.
  return {
    ok: true,
    request: {
      count: unique.length,
      from: actualFrom,
      to: actualTo,
      sites,
    },
    urls: unique.map((r) => r.url),
  };
}

/** Delete every visit of each URL. Logged as irreversible; no snapshot. */
export async function applyHistoryDeletion(
  urls: string[],
): Promise<{ ok: boolean; deleted: number; error?: string; recordId?: string }> {
  const h = api();
  if (!h) return { ok: false, deleted: 0, error: PERMISSION_ERROR };
  let deleted = 0;
  let error: string | undefined;
  for (const url of urls) {
    try {
      await h.deleteUrl({ url });
      deleted += 1;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  if (deleted > 0) {
    const domains = [...new Set(urls.slice(0, deleted).map(hostOf).filter(Boolean))].slice(0, 3);
    const rec = await putChange({
      kind: "history_delete",
      restorable: false,
      count: deleted,
      domains,
    });
    return { ok: !error, deleted, recordId: rec.id, ...(error ? { error } : {}) };
  }
  return { ok: false, deleted, ...(error ? { error } : {}) };
}

export const PERMISSION_ERROR =
  "history permission is not granted — ask the user to allow it from the card, or in Settings → Bookmarks & history";
