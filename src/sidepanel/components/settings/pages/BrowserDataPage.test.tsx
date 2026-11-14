import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { _resetForTests } from "@/lib/idb/db";
import { installChromeApi, installFakeBookmarks, installFakePermissions, type FakeBookmarks, type FakePermissions } from "@/test/fake-browser-data";
import { putChange } from "@/lib/browser-data/changes";
import BrowserDataPage from "./BrowserDataPage";

let perms: FakePermissions;
let bm: FakeBookmarks;

beforeEach(async () => {
  await _resetForTests();
  perms = installFakePermissions([]);
  installChromeApi("permissions", perms);
  bm = installFakeBookmarks({ bar: [{ title: "Vectors", url: "https://a.example.com/vec" }] });
  installChromeApi("bookmarks", bm);
  installChromeApi("history", { search: vi.fn().mockResolvedValue([]), deleteUrl: vi.fn() });
});

afterEach(() => {
  cleanup();
  const g = globalThis as unknown as { chrome: Record<string, unknown> };
  delete g.chrome.permissions;
  delete g.chrome.bookmarks;
  delete g.chrome.history;
});

describe("BrowserDataPage", () => {
  it("shows both permissions as separate rows and reflects the granted state", async () => {
    perms.granted.add("bookmarks");
    render(<BrowserDataPage />);
    await waitFor(() => expect(screen.getByText("Allowed")).toBeTruthy());
    // bookmarks granted → Revoke; history not → Allow.
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("grants only the clicked permission", async () => {
    render(<BrowserDataPage />);
    const bookmarksRow = await screen.findByTestId("browser-data-perm-bookmarks");
    fireEvent.click(within(bookmarksRow).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(perms.granted.has("bookmarks")).toBe(true));
    expect(perms.granted.has("history")).toBe(false);
  });

  it("lists irreversible history deletions without a restore button", async () => {
    await putChange({ kind: "history_delete", restorable: false, count: 37, domains: ["shop.example.com"] });
    render(<BrowserDataPage />);
    await waitFor(() => expect(screen.getByText(/Delete 37 browsing history entries/)).toBeTruthy());
    expect(screen.getByText(/Can't be undone/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("restores a bookmark change from the list", async () => {
    const created = await bm.create({ parentId: bm.barId, title: "New one", url: "https://n.example.com" });
    await putChange({
      kind: "bookmark_create",
      title: "New one",
      restorable: true,
      ops: [{ op: "create_bookmark", id: created.id, parentId: bm.barId, title: "New one", url: "https://n.example.com" }],
    });
    render(<BrowserDataPage />);
    await waitFor(() => expect(screen.getByText(/Bookmark created · New one/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    await waitFor(() => expect(screen.getByText(/Restored 1 change/)).toBeTruthy());
    expect(bm.nodes.has(created.id)).toBe(false);
  });
});
