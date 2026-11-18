import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { getConfig } from "@/lib/idb/config-store";
import {
  MCP_SERVERS_KEY,
  McpConfigError,
  deleteMcpServer,
  displayMcpUrl,
  listMcpServers,
  listMcpServerViews,
  saveMcpServer,
  validateMcpUrl,
  type StoredMcpServer,
} from "./store";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("validateMcpUrl", () => {
  it("accepts https anywhere", () => {
    expect(validateMcpUrl("https://example.com/mcp").ok).toBe(true);
  });
  it("accepts http only on loopback", () => {
    expect(validateMcpUrl("http://localhost:3000/mcp").ok).toBe(true);
    expect(validateMcpUrl("http://127.0.0.1:3000/mcp").ok).toBe(true);
    expect(validateMcpUrl("http://[::1]:3000/mcp").ok).toBe(true);
    expect(validateMcpUrl("http://example.com/mcp").ok).toBe(false);
  });
  it("rejects other schemes and garbage", () => {
    expect(validateMcpUrl("ftp://example.com/mcp").ok).toBe(false);
    expect(validateMcpUrl("not a url").ok).toBe(false);
  });
});

describe("displayMcpUrl", () => {
  it("strips query, userinfo and hash", () => {
    expect(displayMcpUrl("https://user:pass@ex.com/mcp?token=SECRET#frag")).toBe(
      "https://ex.com/mcp",
    );
  });
});

describe("save / list / delete", () => {
  it("encrypts header values at rest and round-trips them", async () => {
    const { id } = await saveMcpServer({
      name: "Google Docs",
      url: "https://ex.com/mcp?token=SECRET",
      headers: [{ key: "Authorization", value: "Bearer SECRET" }],
    });
    const raw = await getConfig<StoredMcpServer[]>(MCP_SERVERS_KEY);
    expect(JSON.stringify(raw)).not.toContain("Bearer SECRET");
    expect(raw?.[0]?.headerKeys).toEqual(["Authorization"]);

    const servers = await listMcpServers();
    expect(servers[0]?.id).toBe(id);
    expect(servers[0]?.slug).toBe("google-docs");
    expect(servers[0]?.headers).toEqual({ Authorization: "Bearer SECRET" });
  });

  it("keeps a saved header value when the form leaves it blank, and drops removed keys", async () => {
    const { id } = await saveMcpServer({
      name: "Docs",
      url: "https://ex.com/mcp",
      headers: [
        { key: "Authorization", value: "Bearer one" },
        { key: "X-Old", value: "old" },
      ],
    });
    await saveMcpServer({
      id,
      name: "Docs",
      url: "https://ex.com/mcp",
      headers: [
        { key: "Authorization", value: "" },
        { key: "X-New", value: "new" },
      ],
    });
    const servers = await listMcpServers();
    expect(servers[0]?.headers).toEqual({ Authorization: "Bearer one", "X-New": "new" });
  });

  it("derives unique slugs, including for non-ASCII names", async () => {
    const a = await saveMcpServer({ name: "Docs", url: "https://a.com/mcp", headers: [] });
    const b = await saveMcpServer({ name: "Docs", url: "https://b.com/mcp", headers: [] });
    const c = await saveMcpServer({ name: "我的文档", url: "https://c.com/mcp", headers: [] });
    expect(a.slug).toBe("docs");
    expect(b.slug).not.toBe(a.slug);
    expect(c.slug).toMatch(/^srv-[0-9a-f]{6}$/);
    const views = await listMcpServerViews();
    expect(views.map((v) => v.slug).sort()).toEqual([a.slug, b.slug, c.slug].sort());
  });

  it("keeps a stored URL query when the (stripped) display URL is saved unchanged", async () => {
    const { id } = await saveMcpServer({
      name: "Docs",
      url: "https://ex.com/mcp?token=SECRET",
      headers: [],
    });
    const [view] = await listMcpServerViews();
    expect(view?.url).toBe("https://ex.com/mcp");
    await saveMcpServer({ id, name: "Docs 2", url: view!.url, headers: [] });
    expect((await listMcpServers())[0]?.url).toBe("https://ex.com/mcp?token=SECRET");
  });

  it("rejects an empty name and a disallowed URL", async () => {
    await expect(saveMcpServer({ name: " ", url: "https://x/mcp", headers: [] })).rejects.toMatchObject({
      code: "nameRequired",
    });
    await expect(
      saveMcpServer({ name: "x", url: "http://evil.com/mcp", headers: [] }),
    ).rejects.toBeInstanceOf(McpConfigError);
  });

  it("deletes by id", async () => {
    const { id } = await saveMcpServer({ name: "Docs", url: "https://x/mcp", headers: [] });
    await deleteMcpServer(id);
    expect(await listMcpServers()).toEqual([]);
  });
});
