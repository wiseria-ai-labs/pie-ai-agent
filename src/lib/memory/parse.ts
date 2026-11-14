// src/lib/memory/parse.ts
//
// 宽松解析模型输出的操作序列。不用 JSON mode（并非所有 provider 稳定支持，
// 调研 §4.7 第 5 条），改用「抽第一个平衡的 JSON 对象」+ 逐条结构校验：
// 任何一条形状不对就丢掉它，不因此丢掉整批。

import { MEMORY_KINDS, type MemoryKind, type MemoryOp } from "./types";

const MAX_OPS = 40;

function isKind(v: unknown): v is MemoryKind {
  return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
}

function isId(v: unknown): v is string {
  return typeof v === "string" && /^m_[0-9a-zA-Z-]+$/.test(v);
}

function str(v: unknown, max = 400): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function tags(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim().slice(0, 24))
    .slice(0, 6);
  return out.length > 0 ? out : undefined;
}

/** 从一段可能带 ```json 围栏 / 前后废话的文本里抠出第一个 JSON 对象。 */
export function extractJsonObject(raw: string): unknown {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  // 逐层平衡扫描（字符串内的花括号不参与计数）。
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 校验并清洗一条操作；形状不对返回 null。 */
export function normalizeOp(raw: unknown): MemoryOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const op = o.op;
  if (typeof op !== "string") return null;

  switch (op) {
    case "add": {
      const title = str(o.title, 60);
      const body = str(o.body, 400);
      if (!isKind(o.kind) || !title) return null;
      return {
        op: "add",
        kind: o.kind,
        title,
        body: body ?? title,
        ...(tags(o.tags) ? { tags: tags(o.tags) } : {}),
        ...(str(o.source_session, 100) ? { source_session: str(o.source_session, 100) } : {}),
      };
    }
    case "update": {
      if (!isId(o.id)) return null;
      const p = (o.patch ?? {}) as Record<string, unknown>;
      const patch: { title?: string; body?: string; tags?: string[]; kind?: MemoryKind } = {};
      const title = str(p.title, 60);
      const body = str(p.body, 400);
      if (title) patch.title = title;
      if (body) patch.body = body;
      const tg = tags(p.tags);
      if (tg) patch.tags = tg;
      if (isKind(p.kind)) patch.kind = p.kind;
      if (Object.keys(patch).length === 0) return null;
      return { op: "update", id: o.id, patch };
    }
    case "merge": {
      if (!Array.isArray(o.ids)) return null;
      const ids = o.ids.filter(isId);
      const title = str(o.title, 60);
      const body = str(o.body, 400);
      if (ids.length < 2 || !title) return null;
      return {
        op: "merge",
        ids,
        title,
        body: body ?? title,
        ...(tags(o.tags) ? { tags: tags(o.tags) } : {}),
        ...(isKind(o.kind) ? { kind: o.kind } : {}),
      };
    }
    case "expire":
      return isId(o.id) ? { op: "expire", id: o.id } : null;
    case "delete":
      return isId(o.id) ? { op: "delete", id: o.id } : null;
    case "profile": {
      const text = str(o.text, 2000);
      return text ? { op: "profile", text } : null;
    }
    default:
      return null;
  }
}

/** 解析整段输出为操作序列（失败 = 空数组）。 */
export function parseMemoryOps(raw: string): MemoryOp[] {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") return [];
  const list = (obj as { ops?: unknown }).ops;
  if (!Array.isArray(list)) return [];
  const out: MemoryOp[] = [];
  for (const item of list) {
    const norm = normalizeOp(item);
    if (norm) out.push(norm);
    if (out.length >= MAX_OPS) break;
  }
  return out;
}
