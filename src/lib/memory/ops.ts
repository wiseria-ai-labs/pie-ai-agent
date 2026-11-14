// src/lib/memory/ops.ts
//
// 纯函数层：把一份操作序列（add / update / merge / expire / delete / profile）
// 作用到当前条目集合上，产出「要写什么」的计划。不碰 IDB、不碰模型，方便单测。
//
// 容量与淘汰（spec §5.4）也在这里：
//   - 长期 ≤ 300 条、近期片段 ≤ 200 条、正文总量 ≤ 20,000 字；
//   - 超限时先淘汰近期片段，再淘汰长期里
//     `recency_decay(30d) × (1 + 0.5 × use_count)` 最低的；
//   - `pinned`（用户显式记住 / 手动编辑过）不自动淘汰。

import { admitMemoryCandidate } from "./admission";
import { escapeUntrustedWrappers } from "@/lib/agent/untrusted-wrappers";
import {
  LONG_TERM_KINDS,
  MEMORY_LONG_TERM_MAX,
  MEMORY_MAX_CHARS,
  MEMORY_PROFILE_MAX_CHARS,
  MEMORY_RECENT_MAX,
  type ConsolidationSummary,
  type MemoryEntry,
  type MemoryEntryOrigin,
  type MemoryKind,
  type MemoryOp,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export function newMemoryId(): string {
  return `m_${crypto.randomUUID()}`;
}

export function isActive(e: MemoryEntry): boolean {
  return e.validTo === undefined;
}

/** 标题归一化（去标点 / 小写 / 压空格），用于去重比对。 */
export function normalizeKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[，。、；：！？,.;:!?"'“”‘’()（）\[\]【】]/g, "");
}

function clipProfile(text: string): string {
  return escapeUntrustedWrappers(String(text ?? "").replace(/\s+\n/g, "\n"))
    .slice(0, MEMORY_PROFILE_MAX_CHARS)
    .trim();
}

/** 淘汰分数：越近用过、用得越多，分越高。 */
export function entryScore(e: MemoryEntry, now: number): number {
  const last = e.lastUsedAt ?? e.updatedAt;
  const ageDays = Math.max(0, now - last) / DAY_MS;
  return Math.exp(-ageDays / 30) * (1 + 0.5 * e.useCount);
}

export interface PlanContext {
  now: number;
  origin: MemoryEntryOrigin;
}

export interface PlanResult {
  /** 应用 + 容量淘汰之后仍然存在的全部条目（调用方整体写回）。 */
  entries: MemoryEntry[];
  deletedIds: string[];
  profileText?: string;
  summary: ConsolidationSummary;
  /** add/update/merge 产生的条目 id（供「用到 / 已更新」事件）。 */
  changedIds: string[];
}

function emptySummary(now: number): ConsolidationSummary {
  return {
    at: now,
    added: 0,
    updated: 0,
    merged: 0,
    expired: 0,
    deleted: 0,
    profileRewritten: false,
  };
}

/**
 * 应用一份操作序列。输入不被修改；返回需要写回的条目 + 删除的 id。
 * 未通过准入的操作会被静默丢弃（计数不计入 added）。
 */
export function planMemoryOps(
  current: MemoryEntry[],
  ops: MemoryOp[],
  ctx: PlanContext,
): PlanResult {
  const byId = new Map(current.map((e) => [e.id, e] as const));
  const summary = emptySummary(ctx.now);
  const changedIds: string[] = [];
  const deleted = new Set<string>();
  let profileText: string | undefined;

  const activeEntries = () => [...byId.values()].filter(isActive);

  const findDuplicate = (kind: MemoryKind, title: string): MemoryEntry | undefined => {
    const key = normalizeKey(title);
    return activeEntries().find((e) => e.kind === kind && normalizeKey(e.title) === key);
  };

  for (const op of ops) {
    if (!op || typeof op !== "object" || typeof op.op !== "string") continue;
    switch (op.op) {
      case "add": {
        const admitted = admitMemoryCandidate(
          { kind: op.kind, title: op.title, body: op.body, tags: op.tags },
          { origin: ctx.origin === "user" ? "user" : ctx.origin },
        );
        if (!admitted.ok) continue;
        const dup = findDuplicate(op.kind, admitted.title);
        if (dup) {
          byId.set(dup.id, {
            ...dup,
            body: admitted.body,
            tags: admitted.tags,
            updatedAt: ctx.now,
            ...(op.source_session ? { sourceSessionId: op.source_session } : {}),
          });
          summary.updated++;
          changedIds.push(dup.id);
          break;
        }
        const entry: MemoryEntry = {
          id: newMemoryId(),
          kind: op.kind,
          title: admitted.title,
          body: admitted.body,
          tags: admitted.tags,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          validFrom: ctx.now,
          useCount: 0,
          origin: ctx.origin,
          ...(op.source_session ? { sourceSessionId: op.source_session } : {}),
        };
        byId.set(entry.id, entry);
        summary.added++;
        changedIds.push(entry.id);
        break;
      }
      case "update": {
        const cur = byId.get(op.id);
        if (!cur) break;
        const admitted = admitMemoryCandidate(
          {
            kind: op.patch.kind ?? cur.kind,
            title: op.patch.title ?? cur.title,
            body: op.patch.body ?? cur.body,
            tags: op.patch.tags ?? cur.tags,
          },
          { origin: ctx.origin === "user" ? "user" : ctx.origin },
        );
        if (!admitted.ok) break;
        byId.set(cur.id, {
          ...cur,
          kind: op.patch.kind ?? cur.kind,
          title: admitted.title,
          body: admitted.body,
          tags: admitted.tags,
          updatedAt: ctx.now,
        });
        summary.updated++;
        changedIds.push(cur.id);
        break;
      }
      case "merge": {
        const sources = op.ids.map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
        if (sources.length < 2) break;
        // 用户手动编辑 / 显式记住的条目（pinned）不参与合并，避免把用户自己
        // 写的内容揉进机器摘要里（spec §5.4「手动编辑过的条目不自动淘汰」）。
        if (sources.some((s) => s.pinned)) break;
        const kind = op.kind ?? sources[0]!.kind;
        const admitted = admitMemoryCandidate(
          { kind, title: op.title, body: op.body, tags: op.tags },
          { origin: ctx.origin === "user" ? "user" : ctx.origin },
        );
        if (!admitted.ok) break;
        const keep = sources[0]!;
        for (const s of sources.slice(1)) {
          byId.delete(s.id);
          deleted.add(s.id);
        }
        byId.set(keep.id, {
          ...keep,
          kind,
          title: admitted.title,
          body: admitted.body,
          tags: admitted.tags,
          updatedAt: ctx.now,
          useCount: sources.reduce((n, s) => n + s.useCount, 0),
          lastUsedAt: Math.max(...sources.map((s) => s.lastUsedAt ?? 0)) || undefined,
        });
        summary.merged += sources.length;
        changedIds.push(keep.id);
        break;
      }
      case "expire": {
        const cur = byId.get(op.id);
        if (!cur || cur.validTo !== undefined) break;
        byId.set(cur.id, { ...cur, validTo: ctx.now });
        summary.expired++;
        break;
      }
      case "delete": {
        if (!byId.has(op.id)) break;
        byId.delete(op.id);
        deleted.add(op.id);
        summary.deleted++;
        break;
      }
      case "profile": {
        const text = clipProfile(op.text);
        if (text) {
          profileText = text;
          summary.profileRewritten = true;
        }
        break;
      }
      default:
        break;
    }
  }

  const survivors = enforceCaps([...byId.values()], ctx.now, deleted);
  return {
    entries: survivors,
    deletedIds: [...deleted],
    ...(profileText !== undefined ? { profileText } : {}),
    summary,
    changedIds,
  };
}

/**
 * 容量兜底：按 spec §5.4 的淘汰顺序移除条目（pinned 除外）。
 * 返回留下的条目；被淘汰的 id 追加到 `deleted`。
 */
export function enforceCaps(
  entries: MemoryEntry[],
  now: number,
  deleted: Set<string> = new Set(),
): MemoryEntry[] {
  let list = entries.slice();
  const drop = (e: MemoryEntry) => {
    list = list.filter((x) => x.id !== e.id);
    deleted.add(e.id);
  };

  const activeOnly = () => list.filter(isActive);
  const oldestFirst = (arr: MemoryEntry[]) =>
    arr.slice().sort((a, b) => entryScore(a, now) - entryScore(b, now));

  // 1) 近期片段超限
  let recent = activeOnly().filter((e) => !LONG_TERM_KINDS.includes(e.kind));
  for (const e of oldestFirst(recent).slice(0, Math.max(0, recent.length - MEMORY_RECENT_MAX))) {
    if (!e.pinned) drop(e);
  }

  // 2) 长期超限
  const longTerm = () => activeOnly().filter((e) => LONG_TERM_KINDS.includes(e.kind));
  for (const e of oldestFirst(longTerm()).slice(
    0,
    Math.max(0, longTerm().length - MEMORY_LONG_TERM_MAX),
  )) {
    if (!e.pinned) drop(e);
  }

  // 3) 正文总量超限
  const totalChars = () => list.reduce((n, e) => n + e.title.length + e.body.length, 0);
  for (const e of oldestFirst(list)) {
    if (totalChars() <= MEMORY_MAX_CHARS) break;
    if (!e.pinned) drop(e);
  }

  return list;
}

/** 月度精简前的保护：把过期很久 / 未使用的近期片段清掉（纯计划，调用方写回）。 */
export function planExpireStaleRecent(
  entries: MemoryEntry[],
  now: number,
  ttlMs: number,
): string[] {
  return entries
    .filter(
      (e) =>
        isActive(e) &&
        !LONG_TERM_KINDS.includes(e.kind) &&
        !e.pinned &&
        now - (e.lastUsedAt ?? e.createdAt) > ttlMs,
    )
    .map((e) => e.id);
}
