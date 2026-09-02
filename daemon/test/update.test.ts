import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compareVersions,
  parseLatest,
  isAllowedUpdateUrl,
  parseTeamId,
  sha256Hex,
  validateUpdateBinary,
  checkUpdate,
  applyUpdate,
  RELEASES_URL_PREFIX,
  PIE_LINK_APP_PATH,
  findTopLevelApp,
  defaultUnzipToBundle,
  type UpdateDeps,
} from "../src/update";
import { DAEMON_VERSION } from "../src/version";

const TEAM = "AB12CD34EF";
const goodUrl = `${RELEASES_URL_PREFIX}download/pie-darwin-universal.zip`;

// ── 纯逻辑 ───────────────────────────────────────────────────────────

test("compareVersions: 三段 semver 各方向", () => {
  expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
  expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  expect(compareVersions("0.1.0", "0.1")).toBe(0); // 缺段补 0
});

test("parseLatest: 合法结构通过，畸形即抛", () => {
  const good = { version: "1.2.3", macos: { url: "u", sha256: "s" }, windows: { url: "u", sha256: "s" } };
  expect(parseLatest(good)).toEqual(good);
  expect(parseLatest(good).app).toBeUndefined();
  expect(() => parseLatest(null)).toThrow();
  expect(() => parseLatest({ version: "1.2.3" })).toThrow(); // 缺 macos/windows
  expect(() => parseLatest({ version: 1, macos: { url: "u", sha256: "s" }, windows: { url: "u", sha256: "s" } })).toThrow();
  expect(() => parseLatest({ version: "1.2.3", macos: { url: "u" }, windows: { url: "u", sha256: "s" } })).toThrow();
});

test("parseLatest: 带 app 的新 json + 未知字段不炸（老 daemon 加法演进；未知字段忽略）", () => {
  const raw = {
    version: "1.2.3",
    macos: { url: "u", sha256: "s" },
    windows: { url: "u", sha256: "s" },
    app: { url: "https://example/app.zip", sha256: "abc" },
    experimental: true,
  };
  const r = parseLatest(raw);
  expect(r.version).toBe("1.2.3");
  expect(r.macos).toEqual({ url: "u", sha256: "s" });
  expect(r.app).toEqual({ url: "https://example/app.zip", sha256: "abc" });
  expect("experimental" in r).toBe(false);
});

test("parseLatest: app 存在但形状不对即抛", () => {
  const base = { version: "1.2.3", macos: { url: "u", sha256: "s" }, windows: { url: "u", sha256: "s" } };
  expect(() => parseLatest({ ...base, app: { url: "u" } })).toThrow(/malformed/);
  expect(() => parseLatest({ ...base, app: "nope" })).toThrow(/malformed/);
  expect(() => parseLatest({ ...base, app: null })).toThrow(/malformed/);
});

test("PIE_LINK_APP_PATH is hardcoded (RPC 不得覆盖)", () => {
  expect(PIE_LINK_APP_PATH).toBe("/Applications/Pie Link.app");
});

test("isAllowedUpdateUrl: 只放行 releases 前缀", () => {
  expect(isAllowedUpdateUrl(goodUrl)).toBe(true);
  expect(isAllowedUpdateUrl("https://evil.example.com/pie.zip")).toBe(false);
  expect(isAllowedUpdateUrl("https://github.com/wiseria-ai-labs/pie-ai-agent/raw/main/x")).toBe(false);
  expect(isAllowedUpdateUrl("http://github.com/wiseria-ai-labs/pie-ai-agent/releases/x")).toBe(false); // 非 https
});

test("parseTeamId: 从 codesign -dv 输出解 TeamIdentifier", () => {
  expect(parseTeamId("Executable=/x\nTeamIdentifier=AB12CD34EF\nSealed=...")).toBe("AB12CD34EF");
  expect(parseTeamId("TeamIdentifier=not set")).toBeNull();
  expect(parseTeamId("no team line here")).toBeNull();
});

test("validateUpdateBinary: 全过才 ok", () => {
  const base = {
    url: goodUrl,
    expectedSha: "abc",
    actualSha: "ABC", // 大小写不敏感
    codesignVerifyOk: true,
    teamId: TEAM,
    expectedTeamId: TEAM,
  };
  expect(validateUpdateBinary(base).ok).toBe(true);
});

test("validateUpdateBinary: 每道闸各自能挡", () => {
  const base = {
    url: goodUrl,
    expectedSha: "abc",
    actualSha: "abc",
    codesignVerifyOk: true,
    teamId: TEAM,
    expectedTeamId: TEAM,
  };
  expect(validateUpdateBinary({ ...base, url: "https://evil.com/x" }).ok).toBe(false); // 闸1
  expect(validateUpdateBinary({ ...base, actualSha: "def" }).ok).toBe(false); // 闸2
  expect(validateUpdateBinary({ ...base, expectedSha: "" }).ok).toBe(false); // 空期望 sha
  expect(validateUpdateBinary({ ...base, codesignVerifyOk: false }).ok).toBe(false); // 闸3a
  expect(validateUpdateBinary({ ...base, teamId: "OTHER99999" }).ok).toBe(false); // 闸3b
  expect(validateUpdateBinary({ ...base, teamId: null }).ok).toBe(false); // 未签
  expect(validateUpdateBinary({ ...base, expectedTeamId: "" }).ok).toBe(false); // fail-closed：未注入 Team ID
});

// ── checkUpdate ──────────────────────────────────────────────────────

function latestJson(version: string) {
  return {
    version,
    macos: { url: `${RELEASES_URL_PREFIX}download/pie-darwin-universal.zip`, sha256: "deadbeef" },
    windows: { url: `${RELEASES_URL_PREFIX}download/pie-link-setup.exe`, sha256: "cafef00d" },
  };
}

test("checkUpdate(darwin): 更高版本 → available=true, supported=true, mac url", async () => {
  const r = await checkUpdate({
    platform: "darwin",
    fetchJson: async () => latestJson("999.0.0"),
  });
  expect(r.current).toBe(DAEMON_VERSION);
  expect(r.latest).toBe("999.0.0");
  expect(r.available).toBe(true);
  expect(r.supported).toBe(true);
  expect(r.url).toContain("pie-darwin-universal.zip");
});

test("checkUpdate(darwin): 同版本 → available=false", async () => {
  const r = await checkUpdate({ platform: "darwin", fetchJson: async () => latestJson(DAEMON_VERSION) });
  expect(r.available).toBe(false);
});

test("checkUpdate(win32): supported=false + windows url", async () => {
  const r = await checkUpdate({ platform: "win32", fetchJson: async () => latestJson("999.0.0") });
  expect(r.supported).toBe(false);
  expect(r.available).toBe(true);
  expect(r.url).toContain("pie-link-setup.exe");
});

// ── applyUpdate ──────────────────────────────────────────────────────

// 造一个「可执行二进制」桩 + 一个假 zip（unzipToBinary 被注入，无需真 ditto）。
function mkFixture(): { binDir: string; binBytes: Uint8Array; sha: string; unzip: UpdateDeps["unzipToBinary"] } {
  const root = mkdtempSync(join(tmpdir(), "pie-upd-test-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "pie"), "OLD-BINARY"); // 现存二进制，验替换/不替换
  const binBytes = new TextEncoder().encode("NEW-BINARY-CONTENT");
  const sha = sha256Hex(binBytes);
  // 注入的 unzip：把「下载物」当成就是二进制本体写出，返回其路径。
  const unzip: UpdateDeps["unzipToBinary"] = (_zip, dest) => {
    mkdirSync(dest, { recursive: true });
    const p = join(dest, "pie-universal");
    writeFileSync(p, binBytes);
    return p;
  };
  return { binDir, binBytes, sha, unzip };
}

function baseDeps(f: ReturnType<typeof mkFixture>, sha: string): Partial<UpdateDeps> {
  return {
    platform: "darwin",
    binDir: f.binDir,
    expectedTeamId: TEAM,
    fetchJson: async () => ({
      version: "999.0.0",
      macos: { url: goodUrl, sha256: sha },
      windows: { url: `${RELEASES_URL_PREFIX}download/pie-link-setup.exe`, sha256: "x" },
    }),
    fetchBytes: async () => f.binBytes,
    unzipToBinary: f.unzip,
    codesignVerify: () => true,
    codesignVerifyDeep: () => true,
    codesignInfo: () => `TeamIdentifier=${TEAM}`,
    // 无 app 字段时不会用到；给一个不会碰到 /Applications 的桩，防止误伤真机。
    appPath: join(f.binDir, "unused-Pie Link.app"),
    unzipToBundle: () => {
      throw new Error("unzipToBundle stub missing (json should not have app)");
    },
  };
}

test("applyUpdate: 三闸全过 → 原子替换 ~/.pie/bin/pie，回新版本号", async () => {
  const f = mkFixture();
  const r = await applyUpdate(baseDeps(f, f.sha));
  expect(r.version).toBe("999.0.0");
  expect(r.path).toBe(join(f.binDir, "pie"));
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
  expect(r.appUpdated).toBe(false); // 老 json 无 app → 跳过、不报错
  expect(r.appError).toBeUndefined();
});

test("applyUpdate: sha256 不符 → 中止且不替换", async () => {
  const f = mkFixture();
  const deps = baseDeps(f, "0000000000000000000000000000000000000000000000000000000000000000");
  await expect(applyUpdate(deps)).rejects.toThrow(/sha256/);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("OLD-BINARY"); // 原封不动
});

test("applyUpdate: 未签名（Team ID 不符）→ 中止且不替换", async () => {
  const f = mkFixture();
  const deps = { ...baseDeps(f, f.sha), codesignInfo: () => "TeamIdentifier=not set" };
  await expect(applyUpdate(deps)).rejects.toThrow(/TeamIdentifier|unsigned/);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("OLD-BINARY");
});

test("applyUpdate: codesign --verify 失败 → 中止且不替换", async () => {
  const f = mkFixture();
  const deps = { ...baseDeps(f, f.sha), codesignVerify: () => false };
  await expect(applyUpdate(deps)).rejects.toThrow(/codesign/);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("OLD-BINARY");
});

test("applyUpdate: json 指向非白名单域 → 未下载即中止", async () => {
  const f = mkFixture();
  let fetched = false;
  const deps: Partial<UpdateDeps> = {
    ...baseDeps(f, f.sha),
    fetchJson: async () => ({
      version: "999.0.0",
      macos: { url: "https://evil.example.com/pie.zip", sha256: f.sha },
      windows: { url: `${RELEASES_URL_PREFIX}download/x.exe`, sha256: "x" },
    }),
    fetchBytes: async () => {
      fetched = true;
      return f.binBytes;
    },
  };
  await expect(applyUpdate(deps)).rejects.toThrow(/allowlist/);
  expect(fetched).toBe(false); // URL 白名单先于下载
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("OLD-BINARY");
});

test("applyUpdate: 非 macOS 平台直接拒绝", async () => {
  const f = mkFixture();
  await expect(applyUpdate({ ...baseDeps(f, f.sha), platform: "win32" })).rejects.toThrow(/self-update is not available/);
});

test("applyUpdate: expectedTeamId 未注入（空）→ fail-closed", async () => {
  const f = mkFixture();
  await expect(applyUpdate({ ...baseDeps(f, f.sha), expectedTeamId: "" })).rejects.toThrow(/Team ID/);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("OLD-BINARY");
});

test("checkUpdate: latest 缺失（404 等）冒泡为错误", async () => {
  await expect(
    checkUpdate({
      platform: "darwin",
      fetchJson: async () => {
        throw new Error("HTTP 404");
      },
    }),
  ).rejects.toThrow(/404/);
});

// ── #419 app bundle（daemon 当 ShipIt）────────────────────────────────

const appZipUrl = `${RELEASES_URL_PREFIX}download/pie-link-app.zip`;

function leftovers(appsDir: string): string[] {
  return readdirSync(appsDir).filter((n) => n.startsWith(".pie-"));
}

function mkAppWorld(): {
  appsDir: string;
  appPath: string;
  appBytes: Uint8Array;
  appSha: string;
  unzipToBundle: UpdateDeps["unzipToBundle"];
} {
  const appsDir = mkdtempSync(join(tmpdir(), "pie-app-upd-"));
  const appPath = join(appsDir, "Pie Link.app");
  mkdirSync(appPath, { recursive: true });
  writeFileSync(join(appPath, "marker"), "OLD-APP");
  const appBytes = new TextEncoder().encode("NEW-APP-ZIP-BYTES");
  const unzipToBundle: UpdateDeps["unzipToBundle"] = (_zip, dest) => {
    mkdirSync(dest, { recursive: true });
    const extracted = join(dest, "Pie Link.app");
    mkdirSync(extracted, { recursive: true });
    writeFileSync(join(extracted, "marker"), "NEW-APP");
    return extracted;
  };
  return { appsDir, appPath, appBytes, appSha: sha256Hex(appBytes), unzipToBundle };
}

function withApp(
  f: ReturnType<typeof mkFixture>,
  app: ReturnType<typeof mkAppWorld>,
  sha = app.appSha,
): Partial<UpdateDeps> {
  return {
    ...baseDeps(f, f.sha),
    appPath: app.appPath,
    unzipToBundle: app.unzipToBundle,
    codesignVerifyDeep: () => true,
    fetchJson: async () => ({
      version: "999.0.0",
      macos: { url: goodUrl, sha256: f.sha },
      windows: { url: `${RELEASES_URL_PREFIX}download/pie-link-setup.exe`, sha256: "x" },
      app: { url: appZipUrl, sha256: sha },
    }),
    fetchBytes: async (url: string) => (url.includes("pie-link-app") ? app.appBytes : f.binBytes),
  };
}

test("applyUpdate: latest 带 app → daemon + bundle 都换，无残留", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  const r = await applyUpdate(withApp(f, app));
  expect(r.version).toBe("999.0.0");
  expect(r.appUpdated).toBe(true);
  expect(r.appError).toBeUndefined();
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("NEW-APP");
  expect(leftovers(app.appsDir)).toEqual([]);
});

test("applyUpdate: 无 app 的老 json → 只更新 daemon、不报错、不动 bundle", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  const r = await applyUpdate({ ...baseDeps(f, f.sha), appPath: app.appPath });
  expect(r.appUpdated).toBe(false);
  expect(r.appError).toBeUndefined();
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("OLD-APP");
  expect(leftovers(app.appsDir)).toEqual([]);
});

test("applyUpdate: app.url 非白名单 → daemon 成功、app 中止、字节不变、无残留", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  let appFetched = false;
  const r = await applyUpdate({
    ...withApp(f, app),
    fetchJson: async () => ({
      version: "999.0.0",
      macos: { url: goodUrl, sha256: f.sha },
      windows: { url: `${RELEASES_URL_PREFIX}download/pie-link-setup.exe`, sha256: "x" },
      app: { url: "https://evil.example.com/app.zip", sha256: app.appSha },
    }),
    fetchBytes: async (url: string) => {
      if (url.includes("evil") || url.includes("pie-link-app")) {
        appFetched = true;
        return app.appBytes;
      }
      return f.binBytes;
    },
  });
  expect(r.appUpdated).toBe(false);
  expect(r.appError).toMatch(/allowlist/);
  expect(appFetched).toBe(false);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("OLD-APP");
  expect(leftovers(app.appsDir)).toEqual([]);
});

test("applyUpdate: app.sha256 不符 → daemon 成功、bundle 不变、无残留", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  const r = await applyUpdate(withApp(f, app, "0".repeat(64)));
  expect(r.appUpdated).toBe(false);
  expect(r.appError).toMatch(/sha256/);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("OLD-APP");
  expect(leftovers(app.appsDir)).toEqual([]);
});

test("applyUpdate: app 未签名（Team ID 不符）→ daemon 成功、bundle 不变、无残留", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  const r = await applyUpdate({
    ...withApp(f, app),
    codesignInfo: (p) => (p.endsWith(".app") ? "TeamIdentifier=not set" : `TeamIdentifier=${TEAM}`),
  });
  expect(r.appUpdated).toBe(false);
  expect(r.appError).toMatch(/TeamIdentifier|unsigned/);
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("OLD-APP");
  expect(leftovers(app.appsDir)).toEqual([]);
});

test("applyUpdate: app codesign --verify --deep 失败 → daemon 成功、bundle 不变、无残留", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  const r = await applyUpdate({ ...withApp(f, app), codesignVerifyDeep: () => false });
  expect(r.appUpdated).toBe(false);
  expect(r.appError).toMatch(/codesign/);
  expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("OLD-APP");
  expect(leftovers(app.appsDir)).toEqual([]);
});

test("applyUpdate: /Applications 不可写 → daemon 成功、appUpdated:false + appError、无残留", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  chmodSync(app.appsDir, 0o555);
  try {
    const r = await applyUpdate(withApp(f, app));
    expect(r.appUpdated).toBe(false);
    expect(r.appError).toMatch(/EACCES|permission denied|EPERM/i);
    expect(readFileSync(join(f.binDir, "pie"), "utf8")).toBe("NEW-BINARY-CONTENT");
    expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("OLD-APP");
    expect(leftovers(app.appsDir)).toEqual([]);
  } finally {
    chmodSync(app.appsDir, 0o755);
  }
});

test("applyUpdate: latest.json 里的 appPath 字段被忽略（不是 RPC/json 合同）", async () => {
  const f = mkFixture();
  const app = mkAppWorld();
  const r = await applyUpdate({
    ...withApp(f, app),
    fetchJson: async () => ({
      version: "999.0.0",
      macos: { url: goodUrl, sha256: f.sha },
      windows: { url: `${RELEASES_URL_PREFIX}download/pie-link-setup.exe`, sha256: "x" },
      app: { url: appZipUrl, sha256: app.appSha },
      appPath: "/tmp/evil.app",
    }),
  });
  expect(r.appUpdated).toBe(true);
  expect(readFileSync(join(app.appPath, "marker"), "utf8")).toBe("NEW-APP");
  expect(existsSync("/tmp/evil.app")).toBe(false);
});

test("findTopLevelApp: 顶层 .app，跳过 __MACOSX，不钻进 Contents/MacOS", () => {
  const dir = mkdtempSync(join(tmpdir(), "pie-app-tree-"));
  mkdirSync(join(dir, "__MACOSX"), { recursive: true });
  mkdirSync(join(dir, "Pie Link.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dir, "Pie Link.app", "Contents", "MacOS", "pie"), "MACHO");
  writeFileSync(join(dir, "__MACOSX", "junk"), "x");
  expect(findTopLevelApp(dir)).toBe(join(dir, "Pie Link.app"));
});

test("findTopLevelApp: 无顶层 .app 即抛", () => {
  const dir = mkdtempSync(join(tmpdir(), "pie-app-empty-"));
  mkdirSync(join(dir, "__MACOSX"), { recursive: true });
  expect(() => findTopLevelApp(dir)).toThrow(/no \.app/);
});

test("defaultUnzipToBundle: 真 ditto 解出顶层 .app（darwin）", () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "pie-ditto-app-"));
  const app = join(root, "Pie Link.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "pie"), "FAKE-MACHO");
  const zip = join(root, "app.zip");
  const packed = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip], { encoding: "utf8" });
  expect(packed.status).toBe(0);
  const dest = join(root, "out");
  const found = defaultUnzipToBundle(zip, dest);
  expect(found).toBe(join(dest, "Pie Link.app"));
  expect(found.includes("MacOS")).toBe(false);
  expect(existsSync(join(found, "Contents", "MacOS", "pie"))).toBe(true);
});
