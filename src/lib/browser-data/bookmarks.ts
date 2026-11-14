// Bookmarks layer for the browser-data line (spec §3.2).
//
// Pure chrome.bookmarks wrappers + the plan/restore machinery. No LLM-facing
// text is built here — the tool layer wraps every external title/URL in
// <untrusted_bookmark>. This module is imported by both the SW tool layer and
// the panel (Settings → 书签与历史 reads local state directly, no RPC hop).
//
// Restore semantics (spec §3.2 / F7): each applied op is recorded with its
// inverse, and restore is conditional — it only withdraws what Pie did. If the
// user moved/renamed/re-filled a node afterwards, that op is skipped.

import type {
  BookmarkChangeOp,
  BookmarkPlanCounts,
  BookmarkPlanLine,
  BookmarkPlanOp,
  BookmarkPlanRequest,
  RestoreResult,
} from "./types";
import { getChange, markChangeRestored, putChange } from "./changes";

const BOOKMARKS_BAR_ID = "1";
const MAX_PLAN_OPS = 200;
const MAX_TITLE = 300;
export const MAX_SEARCH_RESULTS = 50;

function api(): typeof chrome.bookmarks | null {
  return typeof chrome !== "undefined" && chrome.bookmarks ? chrome.bookmarks : null;
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── Tree index ───────────────────────────────────────────────────────────────

export interface BookmarkEntry {
  id: string;
  title: string;
  url: string;
  /** Folder path, e.g. `书签栏/工作`. */
  path: string;
  dateAdded?: number;
}

export interface BookmarkTreeView {
  id: string;
  title: string;
  url?: string;
  folder: boolean;
  children?: BookmarkTreeView[];
  /** Folders/items cut off by the depth limit. */
  omitted: number;
}

interface FlatNode {
  node: chrome.bookmarks.BookmarkTreeNode;
  parentId?: string;
  /** Folder path for folders; containing folder path for bookmarks. */
  path: string;
  /** Folder path including the bookmark's own title for display. */
  fullPath: string;
}

interface Index {
  roots: chrome.bookmarks.BookmarkTreeNode[];
  byId: Map<string, FlatNode>;
}

async function loadIndex(): Promise<Index | null> {
  const b = api();
  if (!b) return null;
  const roots = await b.getTree();
  const byId = new Map<string, FlatNode>();
  const walk = (node: chrome.bookmarks.BookmarkTreeNode, parentPath: string, parentId?: string) => {
    const folder = !!node.url;
    // The synthetic root (id "0") has an empty title — don't let it pollute paths.
    const selfPath = parentPath ? `${parentPath}/${node.title}` : node.title;
    byId.set(node.id, {
      node,
      parentId,
      path: folder ? parentPath : selfPath,
      fullPath: selfPath,
    });
    for (const child of node.children ?? []) walk(child, selfPath, node.id);
  };
  for (const root of roots) walk(root, "", undefined);
  return { roots, byId };
}

function childrenOf(index: Index, id: string): chrome.bookmarks.BookmarkTreeNode[] {
  return index.byId.get(id)?.node.children ?? [];
}

function folderLabel(index: Index, id: string | undefined): string {
  if (!id) return "";
  const flat = index.byId.get(id);
  return flat ? flat.path : id;
}

/**
 * Resolve a folder reference the model supplied: an id, a path (`工作/前端`),
 * or a bare title. `created` maps folders made earlier in the SAME plan by
 * title, so a plan can create a folder and then move bookmarks into it.
 */
function resolveFolder(
  index: Index,
  ref: string | undefined,
  created?: Map<string, string>,
): { ok: true; id: string } | { ok: false; error: string } {
  const raw = (ref ?? "").trim();
  if (!raw) {
    if (index.byId.has(BOOKMARKS_BAR_ID)) return { ok: true, id: BOOKMARKS_BAR_ID };
    // No bookmarks bar (rare: some Chromium forks) — fall back to the first
    // real folder under the synthetic root, never to the root itself.
    const firstRootFolder = index.roots
      .flatMap((r) => r.children ?? [])
      .find((n) => !n.url);
    return firstRootFolder
      ? { ok: true, id: firstRootFolder.id }
      : { ok: false, error: "no bookmark folders exist yet" };
  }
  const createdId = created?.get(raw.toLowerCase());
  if (createdId) return { ok: true, id: createdId };
  const direct = index.byId.get(raw);
  if (direct && !direct.node.url) return { ok: true, id: raw };

  const needle = raw.replace(/^\/+/, "").toLowerCase();
  const folders = [...index.byId.values()].filter((f) => !f.node.url);
  const byPath = folders.find((f) => f.path.toLowerCase() === needle);
  if (byPath) return { ok: true, id: byPath.node.id };
  const suffix = folders.find((f) => f.path.toLowerCase().endsWith(`/${needle}`));
  if (suffix) return { ok: true, id: suffix.node.id };
  const byTitle = folders.find((f) => f.node.title.toLowerCase() === needle);
  if (byTitle) return { ok: true, id: byTitle.node.id };

  const topFolders = index.roots
    .flatMap((r) => r.children ?? [])
    .filter((n) => !n.url)
    .map((n) => n.title);
  return {
    ok: false,
    error: `folder not found: "${raw}". Existing top-level folders: ${topFolders.join(", ") || "(none)"}`,
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function searchBookmarks(opts: {
  query?: string;
  folder?: string;
}): Promise<
  | { ok: true; entries: BookmarkEntry[]; total: number; truncated: boolean }
  | { ok: false; error: string }
> {
  const b = api();
  if (!b) return { ok: false, error: PERMISSION_ERROR };
  const index = await loadIndex();
  if (!index) return { ok: false, error: PERMISSION_ERROR };

  let scopeIds: Set<string> | null = null;
  if (opts.folder && opts.folder.trim()) {
    const folder = resolveFolder(index, opts.folder);
    if (!folder.ok) return folder;
    scopeIds = new Set<string>();
    const collect = (id: string) => {
      scopeIds!.add(id);
      for (const child of childrenOf(index, id)) if (!child.url) collect(child.id);
    };
    collect(folder.id);
  }

  const query = (opts.query ?? "").trim();
  const matched = query
    ? await b.search(query)
    : [...index.byId.values()].map((f) => f.node);

  const entries: BookmarkEntry[] = [];
  for (const node of matched) {
    if (!node.url) continue;
    const flat = index.byId.get(node.id);
    if (!flat) continue;
    if (scopeIds && !scopeIds.has(flat.parentId ?? "")) continue;
    entries.push({
      id: node.id,
      title: node.title,
      url: node.url,
      path: flat.path,
      dateAdded: node.dateAdded,
    });
  }
  return {
    ok: true,
    entries: entries.slice(0, MAX_SEARCH_RESULTS),
    total: entries.length,
    truncated: entries.length > MAX_SEARCH_RESULTS,
  };
}

export async function readBookmarkTree(opts: {
  folderId?: string;
  depth?: number;
}): Promise<{ ok: true; nodes: BookmarkTreeView[]; truncated: number } | { ok: false; error: string }> {
  const b = api();
  if (!b) return { ok: false, error: PERMISSION_ERROR };
  const index = await loadIndex();
  if (!index) return { ok: false, error: PERMISSION_ERROR };

  const depth = Math.max(1, Math.min(5, opts.depth ?? 2));
  let starts: chrome.bookmarks.BookmarkTreeNode[];
  if (opts.folderId && opts.folderId.trim()) {
    const folder = resolveFolder(index, opts.folderId);
    if (!folder.ok) return folder;
    const node = index.byId.get(folder.id)?.node;
    starts = node ? [node] : [];
  } else {
    // Default view: the bookmark bar itself, not the synthetic root.
    const bar = index.byId.get(BOOKMARKS_BAR_ID);
    starts = bar ? [bar.node] : (index.roots[0]?.children ?? []);
  }

  const build = (node: chrome.bookmarks.BookmarkTreeNode, level: number): BookmarkTreeView => {
    if (node.url) {
      return { id: node.id, title: node.title, url: node.url, folder: false, omitted: 0 };
    }
    const children = node.children ?? [];
    if (level >= depth) {
      // Children not expanded below this level — count them all (folders and
      // bookmarks) so the model knows there is more inside.
      return { id: node.id, title: node.title, folder: true, children: [], omitted: children.length };
    }
    const built = children.map((c) => build(c, level + 1));
    return {
      id: node.id,
      title: node.title,
      folder: true,
      children: built,
      omitted: 0,
    };
  };
  return { ok: true, nodes: starts.map((n) => build(n, 0)), truncated: 0 };
}

// ── Single-item writes (create_bookmark / update_bookmark) ───────────────────

export async function createBookmark(input: {
  url: string;
  title: string;
  folder?: string;
}): Promise<{ ok: true; id: string; path: string; duplicateId?: string } | { ok: false; error: string }> {
  const b = api();
  if (!b) return { ok: false, error: PERMISSION_ERROR };
  const url = input.url.trim();
  const title = (input.title ?? "").trim() || url;
  if (!isHttpUrl(url)) return { ok: false, error: `invalid url: ${url} (only http/https can be bookmarked)` };
  if (title.length > MAX_TITLE) return { ok: false, error: `title too long (max ${MAX_TITLE} chars)` };

  const index = await loadIndex();
  if (!index) return { ok: false, error: PERMISSION_ERROR };
  const folder = resolveFolder(index, input.folder);
  if (!folder.ok) return folder;

  const existing = (await b.search({ url })).filter((n) => n.url === url);
  const flatFolder = index.byId.get(folder.id);
  if (existing.length > 0) {
    const flat = [...index.byId.values()].find((f) => f.node.id === existing[0].id);
    return {
      ok: true,
      id: existing[0].id,
      path: flat?.path ?? "",
      duplicateId: existing[0].id,
    };
  }

  const created = await b.create({ parentId: folder.id, title, url });
  await putChange({
    kind: "bookmark_create",
    summary: `新建书签 · ${title}`,
    restorable: true,
    ops: [{ op: "create_bookmark", id: created.id, parentId: folder.id, title, url }],
  });
  return { ok: true, id: created.id, path: flatFolder?.path ?? "" };
}

export async function updateBookmark(input: {
  id: string;
  title?: string;
  parentId?: string;
}): Promise<{ ok: true; id: string; changed: string[] } | { ok: false; error: string }> {
  const b = api();
  if (!b) return { ok: false, error: PERMISSION_ERROR };
  const index = await loadIndex();
  if (!index) return { ok: false, error: PERMISSION_ERROR };

  const current = index.byId.get(input.id);
  if (!current) return { ok: false, error: `bookmark not found: ${input.id}` };
  if (!current.node.url) return { ok: false, error: `id ${input.id} is a folder, not a bookmark` };

  const ops: BookmarkChangeOp[] = [];
  const changed: string[] = [];

  const nextTitle = input.title?.trim();
  if (nextTitle !== undefined && nextTitle !== current.node.title) {
    if (nextTitle.length === 0) return { ok: false, error: "title must not be empty" };
    if (nextTitle.length > MAX_TITLE) return { ok: false, error: `title too long (max ${MAX_TITLE} chars)` };
    await b.update(input.id, { title: nextTitle });
    ops.push({ op: "rename", id: input.id, fromTitle: current.node.title, toTitle: nextTitle });
    changed.push("title");
  }

  if (input.parentId !== undefined && input.parentId !== current.parentId) {
    const folder = resolveFolder(index, input.parentId);
    if (!folder.ok) return { ok: false, error: folder.error };
    await b.move(input.id, { parentId: folder.id });
    ops.push({
      op: "move",
      id: input.id,
      fromParentId: current.parentId ?? BOOKMARKS_BAR_ID,
      toParentId: folder.id,
    });
    changed.push("parent");
  }

  if (ops.length === 0) return { ok: true, id: input.id, changed };

  const parts: string[] = [];
  if (changed.includes("title")) parts.push("改名");
  if (changed.includes("parent")) parts.push("移动");
  await putChange({
    kind: "bookmark_update",
    summary: `${parts.join(" + ")}书签 · ${nextTitle ?? current.node.title}`,
    restorable: true,
    ops,
  });
  return { ok: true, id: input.id, changed };
}

// ── Plan (propose_bookmark_plan) ─────────────────────────────────────────────

function normalizeOp(raw: unknown): BookmarkPlanOp | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "each op must be an object" };
  const o = raw as Record<string, unknown>;
  const op = String(o.op ?? "");
  if (op === "create_folder") {
    const title = String(o.title ?? "").trim();
    if (!title) return { error: "create_folder requires a non-empty title" };
    if (title.length > MAX_TITLE) return { error: "folder title too long" };
    return { op, title, ...(o.parentId !== undefined ? { parentId: String(o.parentId) } : {}) };
  }
  if (op === "move") {
    if (!o.id) return { error: "move requires id" };
    if (o.parentId === undefined) return { error: "move requires parentId (destination folder)" };
    return { op, id: String(o.id), parentId: String(o.parentId) };
  }
  if (op === "rename") {
    const title = String(o.title ?? "").trim();
    if (!o.id) return { error: "rename requires id" };
    if (!title) return { error: "rename requires a non-empty title" };
    if (title.length > MAX_TITLE) return { error: "title too long" };
    return { op, id: String(o.id), title };
  }
  return {
    error: `unknown op "${op}" — allowed: create_folder, move, rename (plans never delete bookmarks)`,
  };
}

/**
 * Validate a plan against live bookmarks and produce the card payload. Returns
 * the normalized ops alongside the payload so apply can reuse the same
 * resolution (including folders created earlier in this plan).
 */
export async function planBookmarkOps(rawOps: unknown): Promise<
  | { ok: true; ops: BookmarkPlanOp[]; request: BookmarkPlanRequest }
  | { ok: false; error: string }
> {
  const b = api();
  if (!b) return { ok: false, error: PERMISSION_ERROR };
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return { ok: false, error: "ops must be a non-empty array" };
  }
  if (rawOps.length > MAX_PLAN_OPS) {
    return { ok: false, error: `too many ops (max ${MAX_PLAN_OPS}) — split the plan into batches` };
  }
  const index = await loadIndex();
  if (!index) return { ok: false, error: PERMISSION_ERROR };

  const ops: BookmarkPlanOp[] = [];
  const created = new Map<string, string>(); // title(lower) → provisional folder id
  const createdTitles: string[] = [];

  for (const raw of rawOps) {
    const normalized = normalizeOp(raw);
    if ("error" in normalized) return { ok: false, error: normalized.error };
    if (normalized.op === "create_folder") {
      const parent = resolveFolder(index, normalized.parentId, created);
      if (!parent.ok) return { ok: false, error: parent.error };
      const key = normalized.title.toLowerCase();
      if (created.has(key)) return { ok: false, error: `duplicate folder "${normalized.title}" in one plan` };
      // Provisional id: real shape is only known after apply.
      created.set(key, `new:${createdTitles.length}`);
      createdTitles.push(normalized.title);
    } else if (normalized.op === "move") {
      const target = index.byId.get(normalized.id);
      if (!target) return { ok: false, error: `bookmark not found: ${normalized.id}` };
      if (!target.node.url) return { ok: false, error: `id ${normalized.id} is a folder — only bookmarks can be moved` };
      const parent = resolveFolder(index, normalized.parentId, created);
      if (!parent.ok) return { ok: false, error: parent.error };
    } else {
      const target = index.byId.get(normalized.id);
      if (!target) return { ok: false, error: `bookmark not found: ${normalized.id}` };
      if (!target.node.url) return { ok: false, error: `id ${normalized.id} is a folder — only bookmarks can be renamed` };
    }
    ops.push(normalized);
  }

  // Counts + diff lines.
  const counts: BookmarkPlanCounts = { folders: 0, moves: 0, renames: 0 };
  const lines: BookmarkPlanLine[] = [];
  const movesIntoTitles = new Map<string, number>();
  for (const op of ops) {
    if (op.op === "move") {
      const key = op.parentId.trim().toLowerCase();
      movesIntoTitles.set(key, (movesIntoTitles.get(key) ?? 0) + 1);
    }
  }
  for (const op of ops) {
    if (op.op === "create_folder") {
      counts.folders += 1;
      const parent = resolveFolder(index, op.parentId, created);
      lines.push({
        kind: "add",
        text: op.title,
        count: movesIntoTitles.get(op.title.toLowerCase()) ?? 0,
        note: parent.ok ? folderLabel(index, parent.id) : undefined,
      });
    } else if (op.op === "move") {
      counts.moves += 1;
      const target = index.byId.get(op.id)!;
      const dest = resolveFolder(index, op.parentId, created);
      lines.push({
        kind: "move",
        text: target.node.title,
        count: 0,
        note: `${target.path} → ${dest.ok ? folderLabel(index, dest.id) : op.parentId}`,
      });
    } else {
      counts.renames += 1;
      const target = index.byId.get(op.id)!;
      lines.push({
        kind: "rename",
        text: `${target.node.title} → ${op.title}`,
        count: 0,
      });
    }
  }

  const totalAffected = counts.folders + counts.moves + counts.renames;
  const titleBits: string[] = [];
  if (counts.folders) titleBits.push(`新建 ${counts.folders} 个文件夹`);
  if (counts.moves) titleBits.push(`移动 ${counts.moves} 个书签`);
  if (counts.renames) titleBits.push(`重命名 ${counts.renames} 个书签`);
  const request: BookmarkPlanRequest = {
    title: titleBits.join(" · ") || "书签整理",
    description: "不会删除任何书签。应用前会自动保存一份快照，可在「设置 → 书签与历史」还原。",
    counts,
    lines: lines.slice(0, MAX_PLAN_OPS),
    totalAffected,
  };
  return { ok: true, ops, request };
}

/** Apply a validated plan: snapshot first, then mutate sequentially. */
export async function applyBookmarkPlan(
  ops: BookmarkPlanOp[],
  label: string,
): Promise<{ ok: boolean; applied: number; recordId: string; error?: string }> {
  const b = api();
  if (!b) return { ok: false, applied: 0, recordId: "", error: PERMISSION_ERROR };
  const index = await loadIndex();
  if (!index) return { ok: false, applied: 0, recordId: "", error: PERMISSION_ERROR };

  const record = await putChange({
    kind: "bookmark_plan",
    summary: label,
    restorable: true,
    ops: [],
  });

  const appliedOps: BookmarkChangeOp[] = [];
  const created = new Map<string, string>();
  let error: string | undefined;

  const flush = async () => {
    await putChange({ ...record, ops: appliedOps });
  };

  for (const op of ops) {
    try {
      if (op.op === "create_folder") {
        const parent = resolveFolder(index, op.parentId, created);
        if (!parent.ok) throw new Error(parent.error);
        const node = await b.create({ parentId: parent.id, title: op.title });
        created.set(op.title.toLowerCase(), node.id);
        appliedOps.push({ op: "create_folder", id: node.id, parentId: parent.id, title: op.title });
      } else if (op.op === "move") {
        const parent = resolveFolder(index, op.parentId, created);
        if (!parent.ok) throw new Error(parent.error);
        const target = index.byId.get(op.id);
        if (!target) throw new Error(`bookmark not found: ${op.id}`);
        await b.move(op.id, { parentId: parent.id });
        appliedOps.push({
          op: "move",
          id: op.id,
          fromParentId: target.parentId ?? BOOKMARKS_BAR_ID,
          toParentId: parent.id,
        });
      } else {
        const target = index.byId.get(op.id);
        if (!target) throw new Error(`bookmark not found: ${op.id}`);
        await b.update(op.id, { title: op.title });
        appliedOps.push({ op: "rename", id: op.id, fromTitle: target.node.title, toTitle: op.title });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  await flush();
  return { ok: !error, applied: appliedOps.length, recordId: record.id, ...(error ? { error } : {}) };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function restoreChangeById(id: string): Promise<RestoreResult> {
  const b = api();
  if (!b) return { ok: false, restored: 0, skipped: 0, error: PERMISSION_ERROR };
  const rec = await getChange(id);
  if (!rec) return { ok: false, restored: 0, skipped: 0, error: "change not found" };
  if (!rec.restorable) return { ok: false, restored: 0, skipped: 0, error: "this change cannot be restored" };
  if (rec.restoredAt) return { ok: false, restored: 0, skipped: 0, error: "already restored" };

  const index = await loadIndex();
  if (!index) return { ok: false, restored: 0, skipped: 0, error: PERMISSION_ERROR };

  let restored = 0;
  let skipped = 0;
  for (const op of [...(rec.ops ?? [])].reverse()) {
    const flat = index.byId.get(op.id);
    try {
      switch (op.op) {
        case "create_folder": {
          // Only undo our own creation: if the user renamed it or moved it,
          // that is their edit and stays.
          if (
            !flat ||
            flat.node.url ||
            flat.node.title !== op.title ||
            (flat.parentId ?? "") !== op.parentId
          ) {
            skipped += 1;
            break;
          }
          // Live emptiness check — the index is a snapshot from before any of
          // the reverse ops above ran, and those moves may have emptied it.
          let kids: chrome.bookmarks.BookmarkTreeNode[];
          try {
            kids = await b.getChildren(op.id);
          } catch {
            skipped += 1;
            break;
          }
          if (kids.length > 0) {
            skipped += 1;
            break;
          }
          await b.remove(op.id);
          restored += 1;
          break;
        }
        case "create_bookmark": {
          if (
            !flat ||
            !flat.node.url ||
            flat.node.title !== op.title ||
            (flat.parentId ?? "") !== op.parentId
          ) {
            skipped += 1;
            break;
          }
          await b.remove(op.id);
          restored += 1;
          break;
        }
        case "move": {
          const stillThere = flat && flat.parentId === op.toParentId;
          const before = index.byId.get(op.fromParentId);
          if (!stillThere || !before || before.node.url) {
            skipped += 1;
            break;
          }
          await b.move(op.id, { parentId: op.fromParentId });
          restored += 1;
          break;
        }
        case "rename": {
          if (!flat || flat.node.title !== op.toTitle) {
            skipped += 1;
            break;
          }
          await b.update(op.id, { title: op.fromTitle });
          restored += 1;
          break;
        }
      }
    } catch {
      skipped += 1;
    }
  }
  await markChangeRestored(id);
  return { ok: true, restored, skipped };
}

export const PERMISSION_ERROR =
  "bookmarks permission is not granted — ask the user to allow it from the card, or in Settings → 书签与历史";
