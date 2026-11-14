import { describe, expect, it } from "vitest";
import {
  buildMcpDispatch,
  deriveSlug,
  exposedMcpToolName,
  isMcpGroupId,
  mcpGroupId,
  mcpSlugFromGroup,
  sanitizeNamePart,
} from "./names";

describe("deriveSlug", () => {
  it("lowercases and hyphenates ASCII names", () => {
    expect(deriveSlug("Google Docs")).toBe("google-docs");
    expect(deriveSlug("  My.Server_2 ")).toBe("my-server-2");
  });

  it("falls back to a deterministic hash for non-ASCII names", () => {
    const a = deriveSlug("我的文档");
    const b = deriveSlug("我的文档");
    expect(a).toBe(b);
    expect(a).toMatch(/^srv-[0-9a-f]{6}$/);
  });

  it("disambiguates taken slugs deterministically", () => {
    const taken = new Set(["google-docs"]);
    const first = deriveSlug("Google Docs", taken);
    expect(first).not.toBe("google-docs");
    expect(first).toMatch(/^google-docs-[0-9a-f]{6}$/);
    expect(deriveSlug("Google Docs", taken)).toBe(first);
  });
});

describe("sanitizeNamePart / exposedMcpToolName", () => {
  it("keeps the provider-safe charset", () => {
    expect(sanitizeNamePart("read.document!")).toBe("read_document");
    expect(sanitizeNamePart("a//b")).toBe("a_b");
    expect(sanitizeNamePart("!!!")).toBe("");
  });

  it("namespaces with mcp_<slug>_", () => {
    expect(exposedMcpToolName("google-docs", "read_document")).toBe(
      "mcp_google-docs_read_document",
    );
  });

  it("starts with a letter and stays within 64 chars after truncation", () => {
    const name = exposedMcpToolName("google-docs", "x".repeat(200));
    expect(name.startsWith("mcp_")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("de-duplicates names that sanitize identically", () => {
    const taken = new Set<string>();
    const a = exposedMcpToolName("s", "a.b", taken);
    taken.add(a);
    const b = exposedMcpToolName("s", "a_b", taken);
    expect(b).not.toBe(a);
    expect(b.length).toBeLessThanOrEqual(64);
  });
});

describe("group ids", () => {
  it("round-trips mcp:<slug>", () => {
    expect(mcpGroupId("docs")).toBe("mcp:docs");
    expect(isMcpGroupId("mcp:docs")).toBe(true);
    expect(isMcpGroupId("pdf")).toBe(false);
    expect(isMcpGroupId("mcp:")).toBe(false);
    expect(mcpSlugFromGroup("mcp:docs")).toBe("docs");
    expect(mcpSlugFromGroup("pdf")).toBeNull();
  });
});

describe("buildMcpDispatch", () => {
  it("maps exposed names back to their server + original tool name", () => {
    const table = buildMcpDispatch([
      { id: "a", slug: "alpha", tools: [{ name: "search" }] },
      { id: "b", slug: "beta", tools: [{ name: "search" }] },
    ]);
    expect(table.get("mcp_alpha_search")).toEqual({ serverId: "a", toolName: "search" });
    expect(table.get("mcp_beta_search")).toEqual({ serverId: "b", toolName: "search" });
  });
});
