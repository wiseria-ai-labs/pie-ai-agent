import { describe, expect, it } from "vitest";
import {
  assignServerSlugs,
  exposeToolNames,
  isMcpGroupId,
  isMcpToolName,
  mcpGroupId,
  PROVIDER_SAFE_TOOL_NAME,
  serverSlug,
} from "./names";

describe("MCP tool names", () => {
  it("builds mcp__<slug>__<tool> and keeps the real name in the reverse map", () => {
    const [e] = exposeToolNames("gdocs", ["get_doc_content"]);
    expect(e).toEqual({ exposedName: "mcp__gdocs__get_doc_content", toolName: "get_doc_content" });
    expect(isMcpToolName(e.exposedName)).toBe(true);
  });

  it("sanitizes to provider-safe characters", () => {
    const entries = exposeToolNames("docs", ["docs.read/file", "créer doc", "a b"]);
    for (const e of entries) expect(e.exposedName).toMatch(PROVIDER_SAFE_TOOL_NAME);
    expect(entries.map((e) => e.toolName)).toEqual(["docs.read/file", "créer doc", "a b"]);
  });

  it("caps at 64 chars with a stable hash suffix", () => {
    const long = "x".repeat(200);
    const [a] = exposeToolNames("docs", [long]);
    const [b] = exposeToolNames("docs", [long]);
    expect(a.exposedName.length).toBeLessThanOrEqual(64);
    expect(a.exposedName).toMatch(PROVIDER_SAFE_TOOL_NAME);
    expect(a.exposedName).toBe(b.exposedName);
  });

  it("disambiguates names that collide after sanitizing; reverse map stays exact", () => {
    const entries = exposeToolNames("docs", ["read.doc", "read/doc", "read_doc"]);
    const exposed = entries.map((e) => e.exposedName);
    expect(new Set(exposed).size).toBe(3);
    const reverse = new Map(entries.map((e) => [e.exposedName, e.toolName]));
    expect([...reverse.values()].sort()).toEqual(["read.doc", "read/doc", "read_doc"]);
  });

  it("server slugs: sanitized, ≤16 chars, unique across servers", () => {
    expect(serverSlug("Google Docs (local)", "id1")).toBe("google_docs_loca");
    expect(serverSlug("📄", "id1")).toMatch(/^s[0-9a-f]{6}$/);
    const slugs = assignServerSlugs([
      { id: "a", name: "Docs" },
      { id: "b", name: "docs" },
      { id: "c", name: "Sheets" },
    ]);
    expect(slugs.get("c")).toBe("sheets");
    expect(slugs.get("a")).not.toBe(slugs.get("b"));
    for (const s of slugs.values()) expect(s.length).toBeLessThanOrEqual(16);
  });

  it("group ids", () => {
    expect(mcpGroupId("docs")).toBe("mcp:docs");
    expect(isMcpGroupId("mcp:docs")).toBe(true);
    expect(isMcpGroupId("pdf")).toBe(false);
  });

  it("no exposed-name collision across servers via '__' in a server name", () => {
    // "a _b" sanitizes to "a__b"; tool "c" there would equal server "a"'s tool "b__c".
    const slugs = assignServerSlugs([
      { id: "x", name: "a" },
      { id: "y", name: "a _b" },
    ]);
    const a = exposeToolNames(slugs.get("x")!, ["b__c"])[0].exposedName;
    const b = exposeToolNames(slugs.get("y")!, ["c"])[0].exposedName;
    expect(a).not.toBe(b);
    for (const s of slugs.values()) expect(s).not.toMatch(/__|^_|_$/);
  });

  it("hashed collision slugs contain no '__' and never take another server's natural slug", () => {
    const servers = [
      { id: "1", name: "abcdefgh_xyz" },
      { id: "2", name: "abcdefgh_xyz" },
    ];
    const first = assignServerSlugs(servers);
    for (const s of first.values()) expect(s).not.toContain("__");
    // A third server literally named like server 1's hashed slug keeps its own name;
    // server 1 must move off it.
    const taken = first.get("1")!;
    const again = assignServerSlugs([...servers, { id: "3", name: taken }]);
    expect(new Set(again.values()).size).toBe(3);
    expect(again.get("3")).toBe(taken);
  });
});
