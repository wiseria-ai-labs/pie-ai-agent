import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { readHistoryForMemory, summarizeHistory } from "../history-source";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("summarizeHistory", () => {
  it("aggregates by host, sums visits, keeps the newest titles", () => {
    const sites = summarizeHistory([
      { url: "https://github.com/a", title: "repo a", lastVisitTime: NOW - 1000, visitCount: 5 },
      { url: "https://github.com/b", title: "repo b", lastVisitTime: NOW, visitCount: 2 },
      { url: "https://mail.google.com/", title: "Inbox", lastVisitTime: NOW - 5000, visitCount: 1 },
      { url: "chrome://settings", title: "Settings", lastVisitTime: NOW, visitCount: 9 },
      { url: "not a url", title: "bad", lastVisitTime: NOW, visitCount: 9 },
    ]);
    expect(sites.map((s) => s.host)).toEqual(["github.com", "mail.google.com"]);
    expect(sites[0]!.visits).toBe(7);
    expect(sites[0]!.lastVisit).toBe(NOW);
    expect(sites[0]!.titles).toEqual(["repo a", "repo b"]);
  });

  it("dedupes titles and caps sites / titles per site", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      url: `https://site${i}.example.com/`,
      title: "same",
      lastVisitTime: NOW,
      visitCount: 1,
    }));
    entries.push({ url: "https://site0.example.com/x", title: "same", lastVisitTime: NOW, visitCount: 1 });
    entries.push({ url: "https://site0.example.com/y", title: "other", lastVisitTime: NOW, visitCount: 1 });

    const sites = summarizeHistory(entries, { maxSites: 3, titlesPerSite: 2 });
    expect(sites).toHaveLength(3);
    expect(sites[0]!.host).toBe("site0.example.com");
    expect(sites[0]!.titles).toEqual(["same", "other"]);
  });
});

describe("readHistoryForMemory", () => {
  it("returns null without the history permission (never reads)", async () => {
    const search = vi.fn();
    const sites = await readHistoryForMemory(NOW, {
      hasPermission: async () => false,
      search: search as never,
    });
    expect(sites).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it("returns null when the search fails", async () => {
    const sites = await readHistoryForMemory(NOW, {
      hasPermission: async () => true,
      search: (async () => ({ ok: false, error: "nope" })) as never,
    });
    expect(sites).toBeNull();
  });

  it("aggregates a permitted window", async () => {
    const sites = await readHistoryForMemory(NOW, {
      hasPermission: async () => true,
      search: (async () => ({
        ok: true,
        total: 1,
        truncated: false,
        entries: [
          { url: "https://github.com/x", title: "repo", lastVisitTime: NOW - 10, visitCount: 3 },
        ],
      })) as never,
    });
    expect(sites).toEqual([
      { host: "github.com", visits: 3, lastVisit: NOW - 10, titles: ["repo"] },
    ]);
  });
});
