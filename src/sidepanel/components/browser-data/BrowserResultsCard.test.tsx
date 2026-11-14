import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { _resetForTests } from "@/lib/idb/db";
import { installChromeApi, installFakeBookmarks, type FakeBookmarks } from "@/test/fake-browser-data";
import { BrowserResultsCard } from "./BrowserResultsCard";

let bm: FakeBookmarks;
let createTab: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await _resetForTests();
  bm = installFakeBookmarks({ bar: [] });
  installChromeApi("bookmarks", bm);
  createTab = vi.fn(async () => ({ id: 99 }));
  (globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs.create = createTab;
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.bookmarks;
  delete (globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs.create;
});

describe("BrowserResultsCard", () => {
  it("renders history rows with site, time and visit count", () => {
    render(
      <BrowserResultsCard
        kind="history"
        total={2}
        entries={[
          { title: "向量数据库选型", url: "https://zhuanlan.example.com/a", lastVisit: 1_700_000_000_000, visits: 3 },
          { title: "Benchmarks", url: "https://qdrant.example.com/b", lastVisit: 1_700_000_100_000, visits: 1 },
        ]}
      />,
    );
    expect(screen.getByText("Browsing history")).toBeTruthy();
    expect(screen.getByText("2 results")).toBeTruthy();
    expect(screen.getByText("向量数据库选型")).toBeTruthy();
    expect(screen.getByText(/zhuanlan\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/3 visits/)).toBeTruthy();
    // favicon = first letter of host, no network request
    expect(screen.getByText("Z")).toBeTruthy();
  });

  it("opens a result in a new tab instead of navigating the panel", () => {
    render(
      <BrowserResultsCard
        kind="history"
        total={1}
        entries={[{ title: "A", url: "https://example.com/page", lastVisit: 1, visits: 1 }]}
      />,
    );
    const link = screen.getByRole("link", { name: /^Open:/ });
    fireEvent.click(link);
    expect(createTab).toHaveBeenCalledWith({ url: "https://example.com/page" });
  });

  it("adds a history result to bookmarks in one click", async () => {
    render(
      <BrowserResultsCard
        kind="history"
        total={1}
        entries={[{ title: "A", url: "https://example.com/page", lastVisit: 1, visits: 1 }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to bookmarks" }));
    await waitFor(() => expect([...bm.nodes.values()].some((n) => n.url === "https://example.com/page")).toBe(true));
  });

  it("bookmark rows carry no add button and show the folder", () => {
    render(
      <BrowserResultsCard
        kind="bookmarks"
        total={1}
        entries={[{ id: "12", title: "Saved", url: "https://s.example.com", folder: "书签栏/工作" }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add to bookmarks" })).toBeNull();
    expect(screen.getByText(/书签栏\/工作/)).toBeTruthy();
  });

  it("says when the list is truncated", () => {
    render(
      <BrowserResultsCard
        kind="history"
        total={50}
        entries={[{ title: "A", url: "https://example.com/a", lastVisit: 1, visits: 1 }]}
      />,
    );
    expect(screen.getByText("49 more not shown")).toBeTruthy();
  });
});
