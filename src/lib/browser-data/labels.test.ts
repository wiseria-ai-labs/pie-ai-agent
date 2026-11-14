import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/use-t";
import { changeLabel, describeChange } from "./labels";
import type { BrowserChangeRecord } from "./types";

const base = { id: "bd_1", at: 1_700_000_000_000, restorable: true };

const plan: BrowserChangeRecord = {
  ...base,
  kind: "bookmark_plan",
  changeCounts: { folders: 2, moves: 71, renames: 0 },
  ops: [],
};
const created: BrowserChangeRecord = { ...base, kind: "bookmark_create", title: "向量数据库选型" };
const updated: BrowserChangeRecord = { ...base, kind: "bookmark_update", title: "Vectors 2" };
const deleted: BrowserChangeRecord = {
  ...base,
  kind: "history_delete",
  restorable: false,
  count: 37,
  domains: ["shop.example.com", "mall.example.org"],
};

describe("changeLabel", () => {
  it("renders an English sentence from structured fields only", () => {
    const t = makeT("en");
    expect(changeLabel(plan, t)).toBe("Bookmark cleanup · 2 new folders · 71 moved");
    expect(changeLabel(created, t)).toBe("Bookmark created · 向量数据库选型");
    expect(changeLabel(updated, t)).toBe("Bookmark updated · Vectors 2");
    expect(changeLabel(deleted, t)).toBe(
      "Delete 37 browsing history entries · shop.example.com, mall.example.org",
    );
  });

  it("renders Chinese for a zh-CN user — the record carries no prose", () => {
    const t = makeT("zh-CN");
    expect(changeLabel(plan, t)).toBe("整理书签 · 新文件夹 2 · 移动 71");
    expect(changeLabel(deleted, t)).toBe("删除 37 条浏览记录 · shop.example.com, mall.example.org");
  });

  it("drops zero-count part labels", () => {
    const d = describeChange({ ...plan, changeCounts: { folders: 0, moves: 0, renames: 3 } });
    expect(d.planParts.filter((p) => p.count > 0)).toEqual([
      { labelKey: "browserData.plan.chipRenames", count: 3 },
    ]);
  });
});
