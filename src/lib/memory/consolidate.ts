// src/lib/memory/consolidate.ts
//
// 每日整理（spec §5.4）。用水位线，不靠准点：
//   - 处理「上次水位线之后结束的会话」，错过几天也不丢，下次一并处理；
//   - 处理完才推进水位线；SW 中途被杀 → 水位线不前进 → 下次重做这一批；
//   - 产出操作序列 JSON，用一次 txMulti 原子写入（applyMemoryOps）。
//
// 输入只取会话里的「用户消息 + 最终回答」摘录（每会话截断），**不含工具返回的
// 网页原文**——这是 §5.3 的防污染底线。

import type { ModelConfig } from "@/lib/model-router";
import type { SessionIndexEntry, SessionMeta } from "@/lib/sessions/types";
import { getSessionMeta, listSessionIndex } from "@/lib/sessions/storage";
import { callMemoryModel, resolveMemoryModel } from "./model";
import {
  buildConsolidationUserPrompt,
  buildHistoryConsolidationUserPrompt,
  buildMemoryIndexLines,
  MEMORY_CONSOLIDATION_SYSTEM_PROMPT,
  MEMORY_HISTORY_SYSTEM_PROMPT,
} from "./prompt";
import { applyMemoryOps, getMemoryProfile, getMemorySettings, getMemoryState, listMemoryEntries } from "./store";
import { isDomainExcluded, hostOf } from "./admission";
import { HISTORY_WINDOW_MS, readHistoryForMemory, type HistorySiteSummary } from "./history-source";
import { parseMemoryOps } from "./parse";
import {
  MEMORY_CONSOLIDATE_MIN_INTERVAL_MS,
  type ConsolidationSummary,
  type MemoryOp,
} from "./types";

/** 每个会话截断到 ~2k token（约 6000 字符）。 */
const SESSION_EXCERPT_CHARS = 6_000;
/** 单次最多处理多少个会话——剩下的留到下次心跳（水位线只推进到处理过的）。 */
const MAX_SESSIONS_PER_RUN = 20;
const CONSOLIDATE_TIMEOUT_MS = 90_000;
/** 浏览历史来源单次最多产出的条目数。 */
const MAX_HISTORY_OPS = 8;

export interface ConsolidationDeps {
  model?: ModelConfig | null;
  now?: number;
  signal?: AbortSignal;
  listSessions?: () => Promise<SessionIndexEntry[]>;
  readSession?: (id: string) => Promise<SessionMeta | null>;
  callModel?: typeof callMemoryModel;
  /** 浏览历史来源（测试注入；默认走 browser-data 的 history + 权限校验）。 */
  readHistory?: (now: number) => Promise<HistorySiteSummary[] | null>;
}

/** 距上次整理是否够久（缺失 lastConsolidatedAt = 从没整理过 → 够久）。 */
export function shouldConsolidate(
  lastConsolidatedAt: number | undefined,
  now: number,
): boolean {
  if (lastConsolidatedAt === undefined) return true;
  return now - lastConsolidatedAt >= MEMORY_CONSOLIDATE_MIN_INTERVAL_MS;
}

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
 * 会话是否整段不进记忆：无痕窗口的任务（spec §5.3「从不记住」）或
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

/**
 * 跑一次每日整理。返回摘要；不需要跑（关着 / 没模型 / 不到 20h）返回 null。
 * 失败（模型超时 / JSON 解析不出）也返回 null，水位线不动。
 *
 * 两个来源（spec §5.3）：
 *   1. 会话摘录（永远）——用户说的 + 最终结论；
 *   2. 浏览历史（设置里打开 + 有 history 权限时）——只有网站与标题，
 *      产出限制在「近期片段 / 常用网站与账号」两类。
 */
export async function runDailyConsolidation(
  deps: ConsolidationDeps = {},
): Promise<ConsolidationSummary | null> {
  const now = deps.now ?? Date.now();
  const settings = await getMemorySettings();
  if (!settings.enabled) return null;

  const model = deps.model !== undefined ? deps.model : await resolveMemoryModel();
  if (!model) return null;

  const state = await getMemoryState();
  if (!shouldConsolidate(state.lastConsolidatedAt, now)) return null;

  const listSessions = deps.listSessions ?? listSessionIndex;
  const readSession = deps.readSession ?? getSessionMeta;
  const callModel = deps.callModel ?? callMemoryModel;

  // ── 来源 1：会话 ──────────────────────────────────────────────────────────
  const sessions = (await listSessions())
    .filter((s) => s.lastAccessedAt > state.watermark)
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, MAX_SESSIONS_PER_RUN);

  const conversations: Array<{ id: string; title?: string; text: string }> = [];
  for (const s of sessions) {
    const meta = await readSession(s.id);
    if (!meta) continue;
    if (isSessionExcluded(meta, settings.excludedDomains)) continue;
    const text = buildSessionExcerpt(meta);
    if (!text) continue;
    conversations.push({
      id: s.id,
      ...(s.title ? { title: s.title } : {}),
      text,
    });
  }

  const newWatermark =
    sessions.length > 0 ? Math.max(...sessions.map((s) => s.lastAccessedAt)) : undefined;

  let sessionOps: MemoryOp[] = [];
  if (conversations.length > 0) {
    const [profile, entries] = await Promise.all([getMemoryProfile(), listMemoryEntries()]);
    const raw = await callModel(
      model,
      [
        { role: "system", content: MEMORY_CONSOLIDATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildConsolidationUserPrompt({
            profileText: profile.text,
            indexLines: buildMemoryIndexLines(entries),
            conversations,
          }),
        },
      ],
      { signal: deps.signal, timeoutMs: CONSOLIDATE_TIMEOUT_MS },
    );
    // 模型失败：整次整理作废（水位线不前进，下次重做这一批）。
    if (!raw) return null;
    sessionOps = parseMemoryOps(raw);
  }

  // ── 来源 2：浏览历史（默认关，权限在 readHistoryForMemory 里校验） ─────────
  let historyOps: MemoryOp[] = [];
  if (settings.historySource) {
    const readHistory = deps.readHistory ?? readHistoryForMemory;
    const sites = await readHistory(now);
    if (sites && sites.length > 0) {
      const entries = await listMemoryEntries();
      const raw = await callModel(
        model,
        [
          { role: "system", content: MEMORY_HISTORY_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildHistoryConsolidationUserPrompt({
              sites,
              // 历史来源只能落在 recent / site，索引也只看这两类。
              indexLines: buildMemoryIndexLines(
                entries.filter((e) => e.kind === "recent" || e.kind === "site"),
              ),
              windowDays: Math.round(HISTORY_WINDOW_MS / 86_400_000),
            }),
          },
        ],
        { signal: deps.signal, timeoutMs: CONSOLIDATE_TIMEOUT_MS },
      );
      // 历史这一路失败不影响会话那一路的结果：静默跳过。
      if (raw) historyOps = restrictHistoryOps(parseMemoryOps(raw));
    }
  }

  const ops = [...sessionOps, ...historyOps];
  if (ops.length === 0 && sessions.length === 0) return null;

  const patch = {
    lastConsolidatedAt: now,
    ...(newWatermark !== undefined ? { watermark: newWatermark } : {}),
  };
  if (ops.length === 0) {
    await applyMemoryOps([], {
      origin: "consolidated",
      now,
      statePatch: patch,
    });
    return null;
  }

  const plan = await applyMemoryOps(ops, {
    origin: "consolidated",
    now,
    statePatch: (p) => ({ ...patch, lastSummary: p.summary }),
  });
  return plan.summary;
}

/**
 * 浏览历史来源的产出白名单：只允许新增「近期片段 / 常用网站与账号」。
 * 其它 op（update / merge / expire / delete / profile）一律丢弃——历史推断不该
 * 改写用户明说的东西，也绝不能写画像。
 */
export function restrictHistoryOps(ops: MemoryOp[]): MemoryOp[] {
  return ops
    .filter(
      (o): o is Extract<MemoryOp, { op: "add" }> =>
        o.op === "add" && (o.kind === "recent" || o.kind === "site"),
    )
    .slice(0, MAX_HISTORY_OPS);
}
