import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { invalidateAllMcpServers } from "./connection";
import { saveMcpServer } from "./store";
import { testMcpServer } from "./test-connection";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
  invalidateAllMcpServers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMcpFetch(overrides: { status?: number; body?: string } = {}): void {
  vi.stubGlobal(
    "fetch",
    ((_url: string, init: RequestInit) => {
      if (overrides.status) {
        return Promise.resolve(new Response(overrides.body ?? "", { status: overrides.status }));
      }
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") {
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "s" },
          }),
        );
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                { name: "read_document", inputSchema: { type: "object", properties: {} } },
                {
                  name: "broken",
                  inputSchema: {
                    type: "object",
                    $defs: { N: { type: "object", properties: { n: { $ref: "#/$defs/N" } } } },
                    properties: { r: { $ref: "#/$defs/N" } },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch,
  );
}

describe("testMcpServer", () => {
  it("returns the exposed tool names plus skipped tools with reasons", async () => {
    stubMcpFetch();
    const { id } = await saveMcpServer({
      name: "Docs",
      url: "http://127.0.0.1:7801/mcp?token=SECRET",
      headers: [{ key: "Authorization", value: "Bearer SECRET" }],
    });
    const res = await testMcpServer(id);
    expect(res.ok).toBe(true);
    expect(res.tools).toEqual(["mcp_docs_read_document"]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]?.name).toBe("broken");
    expect(res.skipped[0]?.reason).toMatch(/circular/i);
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("surfaces HTTP status + body on failure", async () => {
    stubMcpFetch({ status: 403, body: "Origin not allowed" });
    const { id } = await saveMcpServer({ name: "Docs", url: "http://127.0.0.1:7801/mcp", headers: [] });
    const res = await testMcpServer(id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("403");
    expect(res.error).toContain("Origin not allowed");
  });

  it("reports an unknown id without throwing", async () => {
    const res = await testMcpServer("nope");
    expect(res).toMatchObject({ ok: false, tools: [], skipped: [] });
    expect(res.error).toBeTruthy();
  });
});
