import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { MEMORY_TOOLS, isMemoryToolName } from "./memory";
import { listMemoryEntries, rememberEntry, setMemorySettings } from "@/lib/memory/store";
import type { ToolHandlerContext } from "../types";

const ctx: ToolHandlerContext = { tabId: 1, signal: undefined };

function tool(name: string) {
  const t = MEMORY_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("remember", () => {
  it("saves immediately and returns an undoable memory event", async () => {
    const res = await tool("remember").handler(
      { kind: "preference", title: "高铁坐一等座", body: "公司报销" },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(res.memoryEvent?.kind).toBe("updated");
    expect(res.memoryEvent?.eventId).toMatch(/^undo_/);
    expect(await listMemoryEntries()).toHaveLength(1);
  });

  it("refuses when automatic memory is off", async () => {
    await setMemorySettings({ enabled: false });
    const res = await tool("remember").handler(
      { kind: "about", title: "住在杭州", body: "西湖区" },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("turned off");
  });

  it("rejects credentials and bad kinds", async () => {
    const secret = await tool("remember").handler(
      { kind: "about", title: "卡号", body: "6222021234567890123" },
      ctx,
    );
    expect(secret.success).toBe(false);
    expect(secret.error).toContain("credential");

    const badKind = await tool("remember").handler({ kind: "nope", title: "x" }, ctx);
    expect(badKind.success).toBe(false);
    expect(badKind.error).toContain("kind must be one of");
  });

  it("refuses to save anything from an incognito window (§5.3 从不记住)", async () => {
    chromeMock.tabs.__tabsById.set(1, {
      id: 1,
      url: "https://example.com/",
      incognito: true,
    } as unknown as { id: number; url: string });
    const res = await tool("remember").handler(
      { kind: "about", title: "住在杭州", body: "西湖区" },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("incognito");
    expect(await listMemoryEntries()).toHaveLength(0);
  });
});

describe("forget", () => {
  it("deletes by query and leaves an undo event", async () => {
    await rememberEntry({ kind: "about", title: "住在滨江", body: "滨江区" });
    await rememberEntry({ kind: "preference", title: "高铁坐一等座", body: "公司报销" });
    const res = await tool("forget").handler({ query: "滨江" }, ctx);
    expect(res.success).toBe(true);
    expect(res.memoryEvent?.count).toBe(1);
    expect(res.memoryEvent?.kind).toBe("deleted");
    const left = await listMemoryEntries();
    expect(left).toHaveLength(1);
    expect(left[0]!.title).toBe("高铁坐一等座");
  });

  it("reports an honest no-op", async () => {
    const res = await tool("forget").handler({ query: "没有这条" }, ctx);
    expect(res.success).toBe(true);
    expect(res.memoryEvent).toBeUndefined();
    expect(res.observation).toContain("no matching memory");
  });

  it("requires an id or query", async () => {
    const res = await tool("forget").handler({}, ctx);
    expect(res.success).toBe(false);
  });
});

describe("recall_memory", () => {
  it("says nothing was found when there is no memory model", async () => {
    // 没有配置 DeepSeek instance → resolveMemoryModel() 返回 null → 空结果。
    const res = await tool("recall_memory").handler({ query: "我上次说的地址" }, ctx);
    expect(res.success).toBe(true);
    expect(res.observation).toBe("No relevant memories found.");
  });

  it("requires a query", async () => {
    const res = await tool("recall_memory").handler({}, ctx);
    expect(res.success).toBe(false);
  });
});

describe("tool naming", () => {
  it("exposes exactly the three spec tools", () => {
    expect(MEMORY_TOOLS.map((t) => t.name)).toEqual(["remember", "forget", "recall_memory"]);
    expect(isMemoryToolName("remember")).toBe(true);
    expect(isMemoryToolName("recall")).toBe(false);
  });
});
