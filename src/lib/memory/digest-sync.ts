// src/lib/memory/digest-sync.ts
//
// 多设备云端整理的数据收集端：
//   - 在任务结束 / 每小时心跳时，扫描「上次 digestWatermark 之后更新的会话」，
//     只提取用户消息与最终结论（buildSessionExcerpt 已剥离 <untrusted_*> 网页正文），
//     再额外拦截含凭据/密钥的行（containsSecret）、无痕会话与排除域名会话，
//     幂等推送给 POST /memory/digests；
//   - 本机开启「浏览历史」来源且已授 Chrome 权限时，每 ≥20h 推送一次去敏域名统计摘要；
//   - 云端 worker 整理完成后同事务销毁 digest 原文，各端通过 revision 同步最新记忆结果。

import { hasBrowserDataPermission } from "@/lib/browser-data/permissions";
import { getSessionMeta, listSessionIndex } from "@/lib/sessions/storage";
import type { SessionIndexEntry, SessionMeta } from "@/lib/sessions/types";
import { getMemoryAccessState } from "./access";
import { containsSecret, hostOf, isDomainExcluded } from "./admission";
import {
  pushCloudMemoryDigests,
  type CloudDigestItem,
  type MemoryCloudDeps,
} from "./cloud";
import { readHistoryForMemory, type HistorySiteSummary } from "./history-source";
import { formatMemoryDate } from "./prompt";
import { getMemorySettings, getMemoryState, setMemoryState } from "./store";
import { MEMORY_CONSOLIDATE_MIN_INTERVAL_MS } from "./types";

/** 每个会话截断到 ~2k token（约 6000 字符）。 */
const SESSION_EXCERPT_CHARS = 6_000;
const MAX_DIGESTS_PER_BATCH = 20;

const UNTRUSTED_BLOCK_RE =
  /<untrusted_[a-z_]+\b[^>]*>[\s\S]*?<\/untrusted_[a-z_]+>/gi;

/** 用户消息里可能夹着引用的网页原文（<untrusted_page_quote> 等）——整块剔除。 */
export function stripUntrustedBlocks(text: string): string {
  return text.replace(UNTRUSTED_BLOCK_RE, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/** 一个会话的「用户消息 + 最终回答」摘录。 */
export function buildSessionExcerpt(meta: SessionMeta, maxChars = SESSION_EXCERPT_CHARS): string {
  const users: string[] = [];
  let lastAssistant = "";
  for (const m of meta.messages) {
    if (m.role === "user") {
      const text = stripUntrustedBlocks(m.content ?? "").trim();
      if (text) users.push(`[user] ${text}`);
    } else if (m.role === "assistant") {
      const text = (m.content ?? "").trim();
      if (text) lastAssistant = `[assistant] ${text}`;
    }
  }
  const parts = [...users, ...(lastAssistant ? [lastAssistant] : [])];
  const text = parts.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}

/**
 * 会话是否整段不进记忆：无痕窗口的任务（从不记住）或
 * 全部 pin 在「不记住的网站」上的会话。
 */
export function isSessionExcluded(
  meta: SessionMeta,
  excludedDomains: readonly string[],
): boolean {
  if (meta.incognito) return true;
  if (excludedDomains.length === 0) return false;
  const origins = (meta.pinnedTabs ?? []).map((p) => p.origin).filter(Boolean);
  if (origins.length === 0) return false;
  return origins.every((o) => isDomainExcluded(hostOf(o), excludedDomains));
}

export interface FlushDigestsDeps extends MemoryCloudDeps {
  now?: number;
  listSessions?: () => Promise<SessionIndexEntry[]>;
  readSession?: (id: string) => Promise<SessionMeta | null>;
  readHistory?: (now: number) => Promise<HistorySiteSummary[] | null>;
  hasHistoryPermission?: () => Promise<boolean>;
}

function stripSecretLines(excerpt: string): string {
  return excerpt
    .split("\n")
    .filter((line) => !containsSecret(line))
    .join("\n")
    .trim();
}

async function ensureDeviceId(): Promise<string> {
  const state = await getMemoryState();
  if (state.deviceId) return state.deviceId;
  const deviceId = `dev_${crypto.randomUUID()}`;
  await setMemoryState({ deviceId });
  return deviceId;
}

export async function flushMemoryDigests(
  deps: FlushDigestsDeps = {},
): Promise<{ accepted: number }> {
  const access = await getMemoryAccessState();
  if (access.mode !== "cloud_active") return { accepted: 0 };

  const settings = await getMemorySettings();
  if (!settings.enabled) return { accepted: 0 };

  const now = deps.now ?? Date.now();
  const state = await getMemoryState();
  const deviceId = state.deviceId ?? (await ensureDeviceId());
  const watermark = state.digestWatermark ?? state.watermark ?? 0;

  const listSessions = deps.listSessions ?? listSessionIndex;
  const readSession = deps.readSession ?? getSessionMeta;
  const sessions = (await listSessions())
    .filter((s) => s.lastAccessedAt > watermark)
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, MAX_DIGESTS_PER_BATCH);

  const items: CloudDigestItem[] = [];
  for (const s of sessions) {
    const meta = await readSession(s.id);
    if (!meta) continue;
    if (isSessionExcluded(meta, settings.excludedDomains)) continue;
    const rawExcerpt = buildSessionExcerpt(meta);
    if (!rawExcerpt) continue;
    const safePayload = stripSecretLines(rawExcerpt);
    if (!safePayload) continue;
    items.push({
      kind: "session",
      refId: s.id,
      ...(s.title ? { title: s.title } : {}),
      payload: safePayload,
      updatedAt: s.lastAccessedAt,
    });
  }

  let historyUpdatedAt: number | undefined;
  if (
    settings.historySource === true &&
    now - (state.lastHistoryDigestAt ?? 0) >= MEMORY_CONSOLIDATE_MIN_INTERVAL_MS
  ) {
    const hasPerm = deps.hasHistoryPermission
      ? await deps.hasHistoryPermission()
      : await hasBrowserDataPermission("history").catch(() => false);
    if (hasPerm) {
      const readHistory = deps.readHistory ?? readHistoryForMemory;
      const sites = await readHistory(now);
      const filtered = (sites ?? []).filter(
        (site) => !isDomainExcluded(site.host, settings.excludedDomains),
      );
      if (filtered.length > 0) {
        items.push({
          kind: "history",
          refId: `history_${deviceId}_${formatMemoryDate(now)}`,
          payload: JSON.stringify(filtered),
          updatedAt: now,
        });
        historyUpdatedAt = now;
      }
    }
  }

  const nextWatermark =
    sessions.length > 0 ? Math.max(...sessions.map((s) => s.lastAccessedAt)) : undefined;

  if (items.length === 0) {
    if (nextWatermark !== undefined && nextWatermark > watermark) {
      await setMemoryState({ digestWatermark: nextWatermark });
    }
    return { accepted: 0 };
  }

  const res = await pushCloudMemoryDigests(
    access.apiKey,
    { deviceId, items },
    { fetchFn: deps.fetchFn },
  );

  await setMemoryState({
    ...(nextWatermark !== undefined && nextWatermark > watermark
      ? { digestWatermark: nextWatermark }
      : {}),
    ...(historyUpdatedAt !== undefined ? { lastHistoryDigestAt: historyUpdatedAt } : {}),
  });

  return res;
}
