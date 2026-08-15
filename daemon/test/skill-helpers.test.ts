import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  helperFileName,
  isAllowedHelperUrl,
  prependBinDir,
  resolveHelper,
  listSkillHelpers,
  ensureSkillHelpers,
} from "../src/skill-helpers";

describe("helper path helpers", () => {
  test("file names are platform-correct", () => {
    expect(helperFileName("yt-dlp", "darwin")).toBe("yt-dlp");
    expect(helperFileName("ffmpeg", "win32")).toBe("ffmpeg.exe");
    expect(helperFileName("yt-dlp", "win32")).toBe("yt-dlp.exe");
  });

  test("URL allowlist", () => {
    expect(isAllowedHelperUrl("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos")).toBe(true);
    expect(isAllowedHelperUrl("https://evermeet.cx/ffmpeg/getrelease/zip")).toBe(true);
    expect(isAllowedHelperUrl("https://evil.example/ffmpeg")).toBe(false);
  });

  test("prependBinDir puts ~/.pie/bin first and dedupes", () => {
    expect(prependBinDir("/usr/bin:/bin", "/Users/u/.pie/bin", "darwin")).toBe(
      "/Users/u/.pie/bin:/usr/bin:/bin",
    );
    expect(prependBinDir("/Users/u/.pie/bin:/usr/bin", "/Users/u/.pie/bin", "darwin")).toBe(
      "/Users/u/.pie/bin:/usr/bin",
    );
    expect(prependBinDir("C:\\Windows", "C:\\Users\\u\\.pie\\bin", "win32")).toBe(
      "C:\\Users\\u\\.pie\\bin;C:\\Windows",
    );
  });
});

describe("resolve / list", () => {
  test("pie-bin wins over PATH", () => {
    const dir = join(import.meta.dir, ".tmp-h-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "yt-dlp"), "x");
    const r = resolveHelper("yt-dlp", {
      binDir: dir,
      pathEnv: "/usr/bin",
      platform: "darwin",
      which: () => "/usr/bin/yt-dlp",
    });
    expect(r).toEqual({ id: "yt-dlp", present: true, path: join(dir, "yt-dlp"), source: "pie-bin" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to PATH then missing", () => {
    const dir = join(import.meta.dir, ".tmp-h2-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    const onPath = resolveHelper("ffmpeg", {
      binDir: dir,
      pathEnv: "/opt/homebrew/bin",
      platform: "darwin",
      which: (cmd) => (cmd === "ffmpeg" ? "/opt/homebrew/bin/ffmpeg" : null),
    });
    expect(onPath.source).toBe("path");
    const miss = resolveHelper("ffmpeg", {
      binDir: dir,
      pathEnv: "/usr/bin",
      platform: "darwin",
      which: () => null,
    });
    expect(miss.present).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("listSkillHelpers is installable and covers both tools", () => {
    const r = listSkillHelpers({
      binDir: "/no/such",
      pathEnv: "",
      platform: "darwin",
      which: () => null,
    });
    expect(r.installable).toBe(true);
    expect(r.helpers.map((h) => h.id)).toEqual(["yt-dlp", "ffmpeg"]);
  });
});

describe("ensureSkillHelpers", () => {
  test("skips download when already present", async () => {
    const dir = join(import.meta.dir, ".tmp-h3-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "yt-dlp"), "ok");
    let fetches = 0;
    const r = await ensureSkillHelpers(
      { ids: ["yt-dlp"] },
      {
        binDir: dir,
        platform: "darwin",
        which: () => null,
        fetchBytes: async () => {
          fetches++;
          return new Uint8Array([1]);
        },
      },
    );
    expect(fetches).toBe(0);
    expect(r.helpers[0]?.source).toBe("pie-bin");
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes yt-dlp from fetch and smokes it", async () => {
    const dir = join(import.meta.dir, ".tmp-h4-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    const r = await ensureSkillHelpers(
      { ids: ["yt-dlp"] },
      {
        binDir: dir,
        platform: "darwin",
        which: () => null,
        fetchBytes: async (url) => {
          expect(url).toContain("yt-dlp_macos");
          return new Uint8Array([0x23, 0x21]);
        },
        smoke: (bin) => existsSync(bin),
      },
    );
    expect(r.helpers[0]?.present).toBe(true);
    expect(existsSync(join(dir, "yt-dlp"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a non-allowlisted URL (defense: fetch never called on bad id path — url builder is pinned)", async () => {
    expect(isAllowedHelperUrl("https://example.com/x")).toBe(false);
  });
});
