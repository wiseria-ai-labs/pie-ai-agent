import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { _resetForTests } from "@/lib/idb/db";
import { installChromeApi, installFakeBookmarks, type FakeBookmarks } from "@/test/fake-browser-data";
import { putChange } from "@/lib/browser-data/changes";
import { BrowserChangeRow } from "./BrowserChangeRow";

let bm: FakeBookmarks;

beforeEach(async () => {
  await _resetForTests();
  bm = installFakeBookmarks({ bar: [{ title: "Vectors", url: "https://a.example.com/vec" }] });
  installChromeApi("bookmarks", bm);
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.bookmarks;
});

describe("BrowserChangeRow", () => {
  it("shows the localized change label and restores from the conversation", async () => {
    const created = await bm.create({ parentId: bm.barId, title: "New one", url: "https://n.example.com" });
    const rec = await putChange({
      kind: "bookmark_create",
      title: "New one",
      restorable: true,
      ops: [{ op: "create_bookmark", id: created.id, parentId: bm.barId, title: "New one", url: "https://n.example.com" }],
    });

    render(<BrowserChangeRow recordId={rec.id} />);
    await waitFor(() => expect(screen.getByText("Bookmark created · New one")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    await waitFor(() => expect(screen.getByText(/Restored 1 change/)).toBeTruthy());
    expect(bm.nodes.has(created.id)).toBe(false);
  });

  it("labels a plan change with per-op counts", async () => {
    const rec = await putChange({
      kind: "bookmark_plan",
      changeCounts: { folders: 2, moves: 71, renames: 0 },
      restorable: true,
      ops: [],
    });
    render(<BrowserChangeRow recordId={rec.id} />);
    await waitFor(() =>
      expect(screen.getByText("Bookmark cleanup · 2 new folders · 71 moved")).toBeTruthy(),
    );
  });

  it("offers no restore for an irreversible history deletion", async () => {
    const rec = await putChange({
      kind: "history_delete",
      restorable: false,
      count: 37,
      domains: ["shop.example.com"],
    });
    render(<BrowserChangeRow recordId={rec.id} />);
    await waitFor(() => expect(screen.getByText(/Delete 37/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("says when the record has expired", async () => {
    render(<BrowserChangeRow recordId="bd_missing" />);
    await waitFor(() => expect(screen.getByText("This change record has expired.")).toBeTruthy());
  });
});
