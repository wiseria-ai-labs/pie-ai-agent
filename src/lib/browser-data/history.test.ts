import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { installChromeApi, installFakeHistory, type FakeHistory } from "@/test/fake-browser-data";
import {
  applyHistoryDeletion,
  coerceTime,
  proposeHistoryDeletion,
  searchHistory,
  MAX_DELETE_ENTRIES,
} from "./history";
import { listChanges } from "./changes";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T12:00:00Z");

let hist: FakeHistory;

beforeEach(async () => {
  await _resetForTests();
  hist = installFakeHistory([
    { url: "https://shop.example.com/a", title: "Cart", lastVisitTime: NOW - 1 * DAY, visitCount: 3 },
    { url: "https://shop.example.com/b", title: "Deals", lastVisitTime: NOW - 2 * DAY, visitCount: 1 },
    { url: "https://mall.example.org/c", title: "Mall", lastVisitTime: NOW - 3 * DAY, visitCount: 2 },
    { url: "https://news.example.net/d", title: "News", lastVisitTime: NOW - 10 * DAY, visitCount: 1 },
  ]);
  installChromeApi("history", hist);
});

afterEach(() => {
  delete (globalThis as unknown as { chrome: { history?: unknown } }).chrome.history;
});

describe("coerceTime", () => {
  it("accepts epoch ms and ISO strings", () => {
    expect(coerceTime(123)).toBe(123);
    expect(coerceTime("2026-11-07")).toBeTypeOf("number");
    expect(coerceTime("")).toBeUndefined();
    expect(coerceTime("not a date")).toBeUndefined();
  });
});

describe("searchHistory", () => {
  it("defaults to the last 30 days and sorts newest first", async () => {
    const res = await searchHistory({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.title)).toEqual(["Cart", "Deals", "Mall", "News"]);
  });

  it("filters by domain (including subdomains) and by keyword", async () => {
    const byDomain = await searchHistory({ domain: "example.com" });
    expect(byDomain.ok && byDomain.entries.map((e) => e.title)).toEqual(["Cart", "Deals"]);
    const byKeyword = await searchHistory({ query: "mall" });
    expect(byKeyword.ok && byKeyword.entries.map((e) => e.title)).toEqual(["Mall"]);
  });

  it("respects an explicit range and limit", async () => {
    const res = await searchHistory({
      from: new Date(NOW - 3.5 * DAY).toISOString(),
      to: new Date(NOW).toISOString(),
      limit: 2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toHaveLength(2);
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it("rejects an inverted range", async () => {
    const res = await searchHistory({ from: NOW, to: NOW - DAY });
    expect(res.ok).toBe(false);
  });
});

describe("proposeHistoryDeletion", () => {
  it("refuses a filter-less request", async () => {
    const res = await proposeHistoryDeletion({});
    expect(res.ok).toBe(false);
  });

  it("aggregates per-domain counts and reports the actual matched range", async () => {
    const res = await proposeHistoryDeletion({
      domain: "example.com",
      from: new Date(NOW - 5 * DAY).toISOString(),
      to: new Date(NOW).toISOString(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.count).toBe(2);
    expect(res.request.sites).toEqual([{ domain: "shop.example.com", count: 2 }]);
    expect(res.urls).toHaveLength(2);
  });

  it("caps a single deletion card", async () => {
    const many = Array.from({ length: MAX_DELETE_ENTRIES + 1 }, (_, i) => ({
      url: `https://bulk.example.com/${i}`,
      title: `item ${i}`,
      lastVisitTime: NOW - DAY,
      visitCount: 1,
    }));
    installChromeApi("history", installFakeHistory(many));
    const res = await proposeHistoryDeletion({ domain: "bulk.example.com" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("narrow");
  });

  it("reports no matches instead of producing an empty card", async () => {
    const res = await proposeHistoryDeletion({ domain: "nothing.example" });
    expect(res.ok).toBe(false);
  });
});

describe("applyHistoryDeletion", () => {
  it("deletes every visit per URL and logs an irreversible change", async () => {
    const proposed = await proposeHistoryDeletion({ domain: "example.com" });
    if (!proposed.ok) throw new Error("propose failed");
    const res = await applyHistoryDeletion(proposed.urls);
    expect(res).toMatchObject({ ok: true, deleted: 2 });
    expect(hist.entries.map((e) => e.title)).toEqual(["Mall", "News"]);

    const rec = (await listChanges())[0];
    expect(rec).toMatchObject({ kind: "history_delete", restorable: false, count: 2 });
    expect(rec.ops).toBeUndefined();
  });
});
