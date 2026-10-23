import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  getMcpServerHeaders,
  listMcpServers,
  saveMcpServer,
  updateMcpToolsCache,
  validateHeaderName,
  validateServerUrl,
} from "./store";
import { getConfig } from "../idb/config-store";

describe("validateServerUrl", () => {
  it("https anywhere, http only on loopback", () => {
    expect(validateServerUrl("https://mcp.example.com/mcp").ok).toBe(true);
    expect(validateServerUrl("http://localhost:8000/mcp").ok).toBe(true);
    expect(validateServerUrl("http://127.0.0.1:8000/mcp").ok).toBe(true);
    expect(validateServerUrl("http://[::1]:8000/mcp").ok).toBe(true);
    expect(validateServerUrl("http://mcp.example.com/mcp")).toEqual({ ok: false, error: "http-remote" });
    expect(validateServerUrl("ftp://x")).toEqual({ ok: false, error: "bad-scheme" });
    expect(validateServerUrl("not a url")).toEqual({ ok: false, error: "invalid-url" });
  });

  it("header names: tokens only, transport headers reserved", () => {
    expect(validateHeaderName("Authorization")).toBe(true);
    expect(validateHeaderName("X-Api-Key")).toBe(true);
    expect(validateHeaderName("Bad Name")).toBe(false);
    expect(validateHeaderName("Mcp-Session-Id")).toBe(false);
  });
});

describe("MCP server store", () => {
  beforeEach(async () => {
    for (const s of await listMcpServers()) await deleteMcpServer(s.id);
  });

  it("encrypts header values at rest and round-trips them", async () => {
    const s = await saveMcpServer({
      name: "Docs",
      url: "http://localhost:8000/mcp",
      enabled: true,
      consent: "session",
      headers: { Authorization: "Bearer secret-token" },
    });
    const raw = await getConfig<Record<string, unknown>>(`mcp_server_${s.id}`);
    expect(JSON.stringify(raw)).not.toContain("secret-token");
    expect(raw?.headerNames).toEqual(["Authorization"]);
    expect(await getMcpServerHeaders(s)).toEqual({ Authorization: "Bearer secret-token" });
  });

  it("update keeps id/createdAt; changing the URL drops the tools cache", async () => {
    const s = await saveMcpServer({ name: "Docs", url: "http://localhost:8000/mcp", enabled: true, consent: "session", headers: {} });
    await updateMcpToolsCache(s.id, [{ name: "get_doc", readOnly: true }]);
    const same = await saveMcpServer({ name: "Docs 2", url: "http://localhost:8000/mcp", enabled: false, consent: "always", headers: {} }, s.id);
    expect(same).toMatchObject({ id: s.id, createdAt: s.createdAt, consent: "always", enabled: false });
    expect(same.toolsCache?.tools).toHaveLength(1);
    const moved = await saveMcpServer({ name: "Docs", url: "http://localhost:9000/mcp", enabled: true, consent: "always", headers: {} }, s.id);
    expect(moved.toolsCache).toBeUndefined();
    expect((await listMcpServers()).map((x) => x.id)).toEqual([s.id]);
  });

  it("rejects remote http", async () => {
    await expect(
      saveMcpServer({ name: "X", url: "http://example.com/mcp", enabled: true, consent: "session", headers: {} }),
    ).rejects.toThrow("http-remote");
  });
});
