// src/lib/memory/cloud.ts
//
// Pie Pro 云端记忆同步 HTTP 客户端（契约 v2.11 — ACCOUNT_BASE/memory*）。
// 与 managed-research.ts 同模式：强防御归一化（strip JSON null -> undefined），
// 避免 validTo: null 污染本地「仅保留未过期条目」过滤。

import { ACCOUNT_BASE } from "@/lib/managed-config";
import {
  MEMORY_KINDS,
  type ConsolidationSummary,
  type MemoryEntry,
  type MemoryKind,
} from "./types";

export class MemoryCloudError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
    this.name = "MemoryCloudError";
  }
}

export interface CloudMemorySnapshot {
  unchanged: false;
  revision: number;
  readOnly: boolean;
  settings: { enabled: boolean; excludedDomains: string[] };
  profile: { text: string; updatedAt: number };
  state: {
    lastConsolidatedAt?: number;
    lastCompactedAt?: number;
    lastSummary?: ConsolidationSummary;
    hasSnapshot: boolean;
  };
  entries: MemoryEntry[];
}

export type CloudMemoryPullResult =
  | { unchanged: true; revision: number; readOnly: boolean }
  | CloudMemorySnapshot;

export interface CloudDigestItem {
  kind: "session" | "history";
  refId: string;
  title?: string;
  payload: string;
  updatedAt: number;
}

export interface MemoryCloudDeps {
  fetchFn?: typeof fetch;
}

const VALID_KINDS = new Set<string>(MEMORY_KINDS);

function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function normalizeSummary(raw: unknown): ConsolidationSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const at = asNum(r.at);
  if (at === undefined) return undefined;
  return {
    at,
    added: asNum(r.added) ?? 0,
    updated: asNum(r.updated) ?? 0,
    merged: asNum(r.merged) ?? 0,
    expired: asNum(r.expired) ?? 0,
    deleted: asNum(r.deleted) ?? 0,
    profileRewritten: r.profileRewritten === true,
  };
}

export function normalizeCloudEntry(raw: unknown): MemoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asStr(r.id);
  const kind = asStr(r.kind);
  if (!id || !kind || !VALID_KINDS.has(kind)) return null;
  const createdAt = asNum(r.createdAt) ?? Date.now();
  const updatedAt = asNum(r.updatedAt) ?? createdAt;
  const validFrom = asNum(r.validFrom) ?? createdAt;
  const validTo = asNum(r.validTo);
  const lastUsedAt = asNum(r.lastUsedAt);
  const sourceSessionId = asStr(r.sourceSessionId);
  const sourceTitle = asStr(r.sourceTitle);
  const origin =
    r.origin === "explicit" || r.origin === "user" ? r.origin : "consolidated";
  const encrypted = kind === "contact" || r.encrypted === true;

  return {
    id,
    kind: kind as MemoryKind,
    title: typeof r.title === "string" ? r.title : "",
    body: typeof r.body === "string" ? r.body : "",
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === "string")
      : [],
    createdAt,
    updatedAt,
    validFrom,
    ...(validTo !== undefined ? { validTo } : {}),
    useCount: asNum(r.useCount) ?? 0,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(r.pinned === true ? { pinned: true } : {}),
    origin,
    ...(encrypted ? { encrypted: true } : {}),
  };
}

function normalizeSnapshot(raw: unknown): CloudMemorySnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const settingsRaw = (r.settings ?? {}) as Record<string, unknown>;
  const profileRaw = (r.profile ?? {}) as Record<string, unknown>;
  const stateRaw = (r.state ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(r.entries)
    ? r.entries.map(normalizeCloudEntry).filter((e): e is MemoryEntry => e !== null)
    : [];
  const lastConsolidatedAt = asNum(stateRaw.lastConsolidatedAt);
  const lastCompactedAt = asNum(stateRaw.lastCompactedAt);
  const lastSummary = normalizeSummary(stateRaw.lastSummary);

  return {
    unchanged: false,
    revision: asNum(r.revision) ?? 0,
    readOnly: r.readOnly === true,
    settings: {
      enabled: settingsRaw.enabled !== false,
      excludedDomains: Array.isArray(settingsRaw.excludedDomains)
        ? settingsRaw.excludedDomains.filter((d): d is string => typeof d === "string")
        : [],
    },
    profile: {
      text: typeof profileRaw.text === "string" ? profileRaw.text : "",
      updatedAt: asNum(profileRaw.updatedAt) ?? 0,
    },
    state: {
      ...(lastConsolidatedAt !== undefined ? { lastConsolidatedAt } : {}),
      ...(lastCompactedAt !== undefined ? { lastCompactedAt } : {}),
      ...(lastSummary !== undefined ? { lastSummary } : {}),
      hasSnapshot: stateRaw.hasSnapshot === true,
    },
    entries,
  };
}

async function reqJson<T>(
  path: string,
  apiKey: string,
  init: RequestInit & { fetchFn?: typeof fetch } = {},
): Promise<T> {
  const { fetchFn = fetch, headers, ...rest } = init;
  const resp = await fetchFn(`${ACCOUNT_BASE}${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
  });
  if (!resp.ok) {
    let code = `http_${resp.status}`;
    try {
      const b = (await resp.json()) as { error?: string };
      if (b && typeof b.error === "string") code = b.error;
    } catch {
      /* ignore non-JSON error body */
    }
    throw new MemoryCloudError(code, resp.status);
  }
  return (await resp.json()) as T;
}

export async function pullCloudMemory(
  apiKey: string,
  sinceRevision?: number,
  deps: MemoryCloudDeps = {},
): Promise<CloudMemoryPullResult> {
  const q =
    sinceRevision !== undefined && Number.isInteger(sinceRevision) && sinceRevision >= 0
      ? `?sinceRevision=${sinceRevision}`
      : "";
  const raw = await reqJson<Record<string, unknown>>(`/memory${q}`, apiKey, {
    method: "GET",
    fetchFn: deps.fetchFn,
  });
  if (raw.unchanged === true) {
    return {
      unchanged: true,
      revision: asNum(raw.revision) ?? sinceRevision ?? 0,
      readOnly: raw.readOnly === true,
    };
  }
  return normalizeSnapshot(raw);
}

export async function patchCloudMemorySettings(
  apiKey: string,
  patch: { enabled?: boolean; excludedDomains?: string[] },
  deps: MemoryCloudDeps = {},
): Promise<{ revision: number; settings: { enabled: boolean; excludedDomains: string[] } }> {
  return reqJson(`/memory/settings`, apiKey, {
    method: "PATCH",
    body: JSON.stringify(patch),
    fetchFn: deps.fetchFn,
  });
}

export async function pushCloudMemoryDigests(
  apiKey: string,
  body: { deviceId: string; items: CloudDigestItem[] },
  deps: MemoryCloudDeps = {},
): Promise<{ accepted: number }> {
  return reqJson(`/memory/digests`, apiKey, {
    method: "POST",
    body: JSON.stringify(body),
    fetchFn: deps.fetchFn,
  });
}

export async function pickCloudMemory(
  apiKey: string,
  input: { task: string; pageTitle?: string; pageUrl?: string },
  opts: { signal?: AbortSignal; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<{ entries: MemoryEntry[]; revision: number }> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  }
  try {
    const raw = await reqJson<{ entries?: unknown[]; revision?: number }>(`/memory/pick`, apiKey, {
      method: "POST",
      body: JSON.stringify(input),
      signal: ctrl.signal,
      fetchFn: opts.fetchFn,
    });
    const entries = Array.isArray(raw.entries)
      ? raw.entries.map(normalizeCloudEntry).filter((e): e is MemoryEntry => e !== null)
      : [];
    return { entries, revision: asNum(raw.revision) ?? 0 };
  } catch {
    // 挑选超时 / 失败 / abort 是正常降级路径（静默跳过，只带画像）。
    return { entries: [], revision: 0 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export async function cloudRememberEntry(
  apiKey: string,
  input: {
    kind: MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    sourceSessionId?: string;
    sourceTitle?: string;
  },
  deps: MemoryCloudDeps = {},
): Promise<
  | { ok: false; reason: string }
  | {
      ok: true;
      id: string;
      revision: number;
      entry: MemoryEntry;
      event: { eventId: string; kind: "updated"; label: string; encrypted?: boolean };
    }
> {
  const raw = await reqJson<Record<string, unknown>>(`/memory/remember`, apiKey, {
    method: "POST",
    body: JSON.stringify(input),
    fetchFn: deps.fetchFn,
  });
  if (raw.ok !== true) {
    return { ok: false, reason: typeof raw.reason === "string" ? raw.reason : "not_admitted" };
  }
  const entry = normalizeCloudEntry(raw.entry);
  const evt = (raw.event ?? {}) as Record<string, unknown>;
  if (!entry) return { ok: false, reason: "invalid_response" };
  return {
    ok: true,
    id: asStr(raw.id) ?? entry.id,
    revision: asNum(raw.revision) ?? 0,
    entry,
    event: {
      eventId: asStr(evt.eventId) ?? "",
      kind: "updated",
      label: entry.encrypted ? "" : typeof evt.label === "string" ? evt.label : entry.title,
      ...(entry.encrypted ? { encrypted: true } : {}),
    },
  };
}

export async function cloudForgetMemory(
  apiKey: string,
  input: { id?: string; query?: string },
  deps: MemoryCloudDeps = {},
): Promise<{
  count: number;
  eventId: string | null;
  label: string;
  deletedIds: string[];
  revision: number;
}> {
  return reqJson(`/memory/forget`, apiKey, {
    method: "POST",
    body: JSON.stringify(input),
    fetchFn: deps.fetchFn,
  });
}

export async function cloudUpdateMemoryEntry(
  apiKey: string,
  id: string,
  patch: { title: string; body: string; tags?: string[]; kind?: MemoryKind },
  deps: MemoryCloudDeps = {},
): Promise<{ ok: boolean; entry?: MemoryEntry; reason?: string; revision: number }> {
  const raw = await reqJson<Record<string, unknown>>(
    `/memory/entries/${encodeURIComponent(id)}`,
    apiKey,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
      fetchFn: deps.fetchFn,
    },
  );
  const entry = raw.entry ? normalizeCloudEntry(raw.entry) ?? undefined : undefined;
  return {
    ok: raw.ok === true,
    ...(entry ? { entry } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    revision: asNum(raw.revision) ?? 0,
  };
}

export async function cloudDeleteMemoryEntries(
  apiKey: string,
  ids: string[],
  deps: MemoryCloudDeps = {},
): Promise<{ count: number; eventId: string | null; revision: number }> {
  return reqJson(`/memory/entries/delete`, apiKey, {
    method: "POST",
    body: JSON.stringify({ ids }),
    fetchFn: deps.fetchFn,
  });
}

export async function cloudUndoMemoryEvent(
  apiKey: string,
  eventId: string,
  deps: MemoryCloudDeps = {},
): Promise<{ ok: boolean; kind?: "updated" | "deleted"; revision: number }> {
  return reqJson(`/memory/undo`, apiKey, {
    method: "POST",
    body: JSON.stringify({ eventId }),
    fetchFn: deps.fetchFn,
  });
}

export async function cloudRestoreMemorySnapshot(
  apiKey: string,
  deps: MemoryCloudDeps = {},
): Promise<{ ok: boolean; revision: number }> {
  return reqJson(`/memory/snapshot/restore`, apiKey, {
    method: "POST",
    body: JSON.stringify({}),
    fetchFn: deps.fetchFn,
  });
}

export async function cloudClearAllMemory(
  apiKey: string,
  deps: MemoryCloudDeps = {},
): Promise<{ ok: boolean; revision: number }> {
  return reqJson(`/memory/clear`, apiKey, {
    method: "POST",
    body: JSON.stringify({}),
    fetchFn: deps.fetchFn,
  });
}

export async function cloudImportMemory(
  apiKey: string,
  payload: {
    profileText?: string;
    entries?: MemoryEntry[];
    settings?: { enabled?: boolean; excludedDomains?: string[] };
  },
  deps: MemoryCloudDeps = {},
): Promise<CloudMemorySnapshot> {
  const raw = await reqJson<Record<string, unknown>>(`/memory/import`, apiKey, {
    method: "POST",
    body: JSON.stringify(payload),
    fetchFn: deps.fetchFn,
  });
  return normalizeSnapshot(raw);
}
