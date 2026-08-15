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
  helperVersionLooksRight,
  ytdlpUrl,
  isMachOFile,
  pythonMeetsYtdlp,
} from "../src/skill-helpers";

describe("pythonMeetsYtdlp", () => {
  test("requires 3.10+", () => {
    expect(pythonMeetsYtdlp("Python 3.9.6")).toBe(false);
    expect(pythonMeetsYtdlp("Python 3.10.0")).toBe(true);
    expect(pythonMeetsYtdlp("Python 3.14.3")).toBe(true);
  });
});

describe("helperVersionLooksRight", () => {
  test("yt-dlp --version is a date, not the word yt-dlp", () => {
    expect(helperVersionLooksRight("yt-dlp", "2026.07.04\n")).toBe(true);
    expect(helperVersionLooksRight("yt-dlp", "yt-dlp 2026.07.04")).toBe(true);
    expect(helperVersionLooksRight("yt-dlp", "Permission denied")).toBe(false);
  });
  test("ffmpeg must mention ffmpeg", () => {
    expect(helperVersionLooksRight("ffmpeg", "ffmpeg version 8.0.1 Copyright")).toBe(true);
    expect(helperVersionLooksRight("ffmpeg", "2026.07.04")).toBe(false);
  });
});

describe("ytdlpUrl", () => {
  test("mac/linux use zipimport, not PyInstaller onefile", () => {
    expect(ytdlpUrl("darwin")).toBe("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp");
    expect(ytdlpUrl("linux")).toBe("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp");
    expect(ytdlpUrl("win32")).toContain("yt-dlp.exe");
    expect(ytdlpUrl("darwin")).not.toContain("macos");
  });
});

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

  test("Mach-O yt-dlp in pie-bin is treated as missing on darwin", () => {
    const dir = join(import.meta.dir, ".tmp-macho-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    const fat = Buffer.alloc(8);
    fat.writeUInt32BE(0xcafebabe, 0);
    writeFileSync(join(dir, "yt-dlp"), fat);
    expect(isMachOFile(join(dir, "yt-dlp"))).toBe(true);
    const r = resolveHelper("yt-dlp", {
      binDir: dir,
      pathEnv: "/usr/bin",
      platform: "darwin",
      which: () => null,
    });
    expect(r.present).toBe(false);
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
        which: (cmd) => (cmd.startsWith("python") ? "/opt/homebrew/bin/python3.14" : null),
        pythonVersion: () => "Python 3.14.3",
        fetchBytes: async (url) => {
          expect(url.endsWith("/yt-dlp")).toBe(true);
          expect(url).not.toContain("macos");
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
