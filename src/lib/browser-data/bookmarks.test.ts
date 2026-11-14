import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { installChromeApi, installFakeBookmarks, type FakeBookmarks } from "@/test/fake-browser-data";
import {
  applyBookmarkPlan,
  checkBookmarkLinks,
  createBookmark,
  MAX_LINK_CHECKS,
  planBookmarkOps,
  readBookmarkTree,
  restoreChangeById,
  searchBookmarks,
  updateBookmark,
  type BookmarkTreeView,
} from "./bookmarks";
import { listChanges } from "./changes";

let bm: FakeBookmarks;

beforeEach(async () => {
  await _resetForTests();
  bm = installFakeBookmarks({
    bar: [
      { title: "Vectors", url: "https://a.example.com/vec" },
      { title: "Benchmarks", url: "https://b.example.com/bench" },
    ],
  });
  installChromeApi("bookmarks", bm);
});

afterEach(() => {
  delete (globalThis as unknown as { chrome: { bookmarks?: unknown } }).chrome.bookmarks;
});

function findNodeByTitle(title: string) {
  return [...bm.nodes.values()].find((n) => n.title === title);
}

describe("searchBookmarks", () => {
  it("matches title/url keywords and reports the containing folder path", async () => {
    await bm.create({ parentId: bm.barId, title: "Work", url: undefined });
    const res = await searchBookmarks({ query: "vec" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(1);
    expect(res.entries[0].title).toBe("Vectors");
    expect(res.entries[0].path).toBe("Bookmarks bar");
  });

  it("scopes to a folder subtree", async () => {
    const sub = await bm.create({ parentId: bm.barId, title: "Deep" });
    await bm.create({ parentId: sub.id, title: "Nested vec", url: "https://n.example.com/vec" });
    const inSub = await searchBookmarks({ query: "vec", folder: "Deep" });
    expect(inSub.ok && inSub.entries.map((e) => e.title)).toEqual(["Nested vec"]);
    const atRoot = await searchBookmarks({ query: "vec" });
    expect(atRoot.ok && atRoot.entries.length).toBe(2);
  });

  it("errors with the folder list when the folder is unknown", async () => {
    const res = await searchBookmarks({ folder: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("folder not found");
  });
});

describe("readBookmarkTree", () => {
  it("reports how many children are cut off below the depth limit", async () => {
    const sub = await bm.create({ parentId: bm.barId, title: "Deep" });
    await bm.create({ parentId: sub.id, title: "Deeper" });
    await bm.create({ parentId: sub.id, title: "Deeper page", url: "https://d.example.com" });
    const res = await readBookmarkTree({ depth: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bar = res.nodes[0] as BookmarkTreeView;
    expect(bar.folder).toBe(true);
    const deep = bar.children?.find((c) => c.title === "Deep");
    expect(deep?.children).toEqual([]);
    expect(deep?.omitted).toBe(2); // one nested folder + one bookmarked page
  });

  it("expands the requested subtree at higher depth", async () => {
    const sub = await bm.create({ parentId: bm.barId, title: "Deep" });
    await bm.create({ parentId: sub.id, title: "Deeper" });
    const res = await readBookmarkTree({ folderId: "Deep", depth: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.nodes[0].children?.[0].title).toBe("Deeper");
  });
});

describe("createBookmark / updateBookmark", () => {
  it("creates a bookmark and logs a restorable change", async () => {
    const res = await createBookmark({ url: "https://c.example.com/x", title: "C" });
    expect(res.ok && res.id).toBeTruthy();
    const changes = await listChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "bookmark_create", restorable: true });
  });

  it("is idempotent for an already-bookmarked URL", async () => {
    const res = await createBookmark({ url: "https://a.example.com/vec", title: "dup" });
    expect(res.ok && res.duplicateId).toBeTruthy();
    expect(await listChanges()).toHaveLength(0);
  });

  it("rejects non-http(s) URLs", async () => {
    const res = await createBookmark({ url: "javascript:alert(1)", title: "x" });
    expect(res.ok).toBe(false);
  });

  it("records rename + move with inverses", async () => {
    const target = findNodeByTitle("Vectors")!;
    const folder = await bm.create({ parentId: bm.barId, title: "Work" });
    const res = await updateBookmark({ id: target.id, title: "Vectors 2", parentId: "Work" });
    expect(res.ok).toBe(true);
    const rec = (await listChanges())[0];
    expect(rec.ops).toEqual([
      { op: "rename", id: target.id, fromTitle: "Vectors", toTitle: "Vectors 2" },
      { op: "move", id: target.id, fromParentId: bm.barId, toParentId: folder.id },
    ]);
  });
});

describe("planBookmarkOps", () => {
  it("rejects delete ops — plans never remove bookmarks", async () => {
    const res = await planBookmarkOps([{ op: "delete", id: "100" }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("never delete");
  });

  it("rejects unknown targets", async () => {
    const res = await planBookmarkOps([{ op: "move", id: "nope", parentId: "工作" }]);
    expect(res.ok).toBe(false);
  });

  it("accepts moves into a folder created earlier in the same plan", async () => {
    const a = findNodeByTitle("Vectors")!;
    const b = findNodeByTitle("Benchmarks")!;
    const res = await planBookmarkOps([
      { op: "create_folder", title: "工作" },
      { op: "move", id: a.id, parentId: "工作" },
      { op: "move", id: b.id, parentId: "工作" },
      { op: "rename", id: b.id, title: "Benchmarks 2026" },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.counts).toEqual({ folders: 1, moves: 2, renames: 1 });
    // The created folder's line carries how many bookmarks move into it.
    expect(res.request.lines[0]).toMatchObject({ kind: "add", text: "工作", count: 2 });
    expect(res.request.totalAffected).toBe(4);
  });
});

describe("applyBookmarkPlan + restore", () => {
  it("applies the plan, snapshots it, and restore withdraws exactly that change", async () => {
    const a = findNodeByTitle("Vectors")!;
    const b = findNodeByTitle("Benchmarks")!;
    const planned = await planBookmarkOps([
      { op: "create_folder", title: "工作" },
      { op: "move", id: a.id, parentId: "工作" },
      { op: "rename", id: b.id, title: "Benchmarks 2026" },
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const applied = await applyBookmarkPlan(planned.ops);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(3);

    const folder = findNodeByTitle("工作")!;
    expect(findNodeByTitle("Vectors")!.parentId).toBe(folder.id);
    expect(findNodeByTitle("Benchmarks 2026")).toBeTruthy();

    const rec = (await listChanges())[0];
    expect(rec).toMatchObject({ kind: "bookmark_plan", restorable: true });
    expect(rec.ops).toHaveLength(3);

    const restored = await restoreChangeById(rec.id);
    expect(restored).toMatchObject({ ok: true, restored: 3, skipped: 0 });
    expect(findNodeByTitle("Vectors")!.parentId).toBe(bm.barId);
    expect(findNodeByTitle("工作")).toBeUndefined();
    expect(findNodeByTitle("Benchmarks 2026")).toBeUndefined();
    expect(findNodeByTitle("Benchmarks")).toBeTruthy();

    // Second restore is refused.
    const again = await restoreChangeById(rec.id);
    expect(again.ok).toBe(false);
  });

  it("skips nodes the user changed after Pie's change", async () => {
    const a = findNodeByTitle("Vectors")!;
    const planned = await planBookmarkOps([
      { op: "create_folder", title: "工作" },
      { op: "move", id: a.id, parentId: "工作" },
    ]);
    if (!planned.ok) throw new Error("plan failed");
    await applyBookmarkPlan(planned.ops);
    const rec = (await listChanges())[0];

    // User takes the bookmark back out AND puts something in the new folder.
    await bm.move(a.id, { parentId: bm.barId });
    await bm.create({ parentId: findNodeByTitle("工作")!.id, title: "User note", url: "https://u.example.com" });

    const restored = await restoreChangeById(rec.id);
    expect(restored.ok).toBe(true);
    expect(restored.restored).toBe(0);
    expect(restored.skipped).toBe(2);
    expect(findNodeByTitle("工作")).toBeTruthy(); // keeps the user's content
  });
});

// ── check_bookmark_links (spec §3.2: HEAD, concurrency 6, 5 s timeout) ──────

describe("checkBookmarkLinks", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
    );
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("uses HEAD and reports only 404 / 410 / transport failures", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      if (url.includes("/gone")) return new Response(null, { status: 404 });
      if (url.includes("/removed")) return new Response(null, { status: 410 });
      if (url.includes("/blocked")) return new Response(null, { status: 403 });
      if (url.includes("/headless")) return new Response(null, { status: 405 });
      if (url.includes("/down")) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 200 });
    });
    for (const [title, path] of [
      ["Gone", "gone"],
      ["Removed", "removed"],
      ["Blocked", "blocked"],
      ["NoHead", "headless"],
      ["Down", "down"],
      ["Live", "live"],
    ] as const) {
      await bm.create({ parentId: bm.barId, title, url: `https://x.example.com/${path}` });
    }

    const res = await checkBookmarkLinks({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checked).toBe(8); // 2 seeded + 6
    expect(res.dead.map((d) => [d.title, d.reason]).sort()).toEqual([
      ["Down", "network"],
      ["Gone", "404"],
      ["Removed", "410"],
    ]);
    expect(seen.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("treats a request that never settles as a timeout (aborted)", async () => {
    mockFetch(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const res = await checkBookmarkLinks({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dead.every((d) => d.reason === "timeout")).toBe(true);
  });

  it("honours the per-call concurrency cap of 6", async () => {
    let inFlight = 0;
    let peak = 0;
    mockFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    });
    for (let i = 0; i < 12; i += 1) {
      await bm.create({ parentId: bm.barId, title: `L${i}`, url: `https://c.example.com/${i}` });
    }
    const res = await checkBookmarkLinks({});
    expect(res.ok && res.checked).toBe(14);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("checks a single folder subtree", async () => {
    const folder = await bm.create({ parentId: bm.barId, title: "Work" });
    await bm.create({ parentId: folder.id, title: "Inside", url: "https://w.example.com/in" });
    mockFetch(() => new Response(null, { status: 200 }));
    const res = await checkBookmarkLinks({ folderId: "Work" });
    expect(res.ok && res.checked).toBe(1);
  });

  it("refuses scopes above the cap instead of silently truncating", async () => {
    for (let i = 0; i < MAX_LINK_CHECKS + 1; i += 1) {
      await bm.create({ parentId: bm.barId, title: `B${i}`, url: `https://big.example.com/${i}` });
    }
    const res = await checkBookmarkLinks({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("narrow");
  });
});
