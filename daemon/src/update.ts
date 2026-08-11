// daemon/src/update.ts — Pie Link 零提权自更新（#403，仅 macOS 落地替换）。
//
// 关键事实：daemon 真身住 ~/.pie/bin/pie（用户可写），plist / host wrapper 都指它，
// /usr/local/bin/pie 只是个 symlink。所以更新 = 下载新二进制 → 硬验签 → 原子 rename
// 覆盖 ~/.pie/bin/pie。替换运行中的二进制靠 unlink+rename 换 inode（老进程继续跑老
// inode），rustup/nvm 长期这么做，macOS 上成立。重启由顶栏 app 发 launchctl kickstart。
//
// **安全模型（apply_update 的三道硬闸，任一失败即中止且不替换现有二进制）**：
//   1. URL 白名单：latest.json 的 url 必须以我们的 releases/ 前缀开头（挡住被篡改的
//      json 指向任意主机）。
//   2. sha256：下载物哈希必须等于 json 里声明的。
//   3. codesign：解出的二进制 `codesign --verify --strict` 通过，且 `codesign -dv`
//      报的 TeamIdentifier 等于我们的 Team ID（**编译期注入、不从下载物读**）。
//
// 纯逻辑（版本比较 / URL 白名单 / 校验闸 / codesign 输出解析）抽成可单测的纯函数；
// IO（fetch / exec / fs）经 deps 注入，默认实现走真机。

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync, existsSync, chmodSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import nodePath from "path";
import { paths } from "./paths";
import { DAEMON_VERSION } from "./version";
import type { PieLinkLatest, CheckUpdateResult, ApplyUpdateResult } from "../../src/types/local-bridge";

/** latest.json 固定 URL（release asset，靠 /releases/latest/download/ 稳定命中）。 */
export const LATEST_JSON_URL =
  "https://github.com/wiseria-ai-labs/pie-ai-agent/releases/latest/download/pie-link-latest.json";

/** 更新物 URL 白名单前缀。json 里的 url 必须以此开头，否则拒绝下载（防篡改指向任意主机）。 */
export const RELEASES_URL_PREFIX = "https://github.com/wiseria-ai-labs/pie-ai-agent/releases/";

/**
 * 期望的 Apple Developer Team ID —— **编译期由 `--define process.env.PIE_TEAM_ID` 注入**
 * （与 PIE_DAEMON_VERSION 同机制，release-pkg.sh 设置），内嵌进签名二进制、**永不从下载物读**。
 * 本地开发 / 无 define → 空串 → 校验 fail-closed（validateUpdateBinary 视空为配置错、拒绝替换）。
 */
export const EXPECTED_TEAM_ID: string = process.env.PIE_TEAM_ID || "";

// ── 纯逻辑（可单测）──────────────────────────────────────────────────

/** 三段 semver 比较，与扩展侧 compareDaemonVersions 同语义（无 prerelease）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** latest.json 结构校验：形状不对即抛（挡住半个 json / 缺字段）。 */
export function parseLatest(raw: unknown): PieLinkLatest {
  const o = raw as Partial<PieLinkLatest> | null;
  const okPlat = (p: unknown): p is { url: string; sha256: string } =>
    !!p && typeof (p as { url?: unknown }).url === "string" && typeof (p as { sha256?: unknown }).sha256 === "string";
  if (!o || typeof o.version !== "string" || !okPlat(o.macos) || !okPlat(o.windows)) {
    throw new Error("malformed pie-link-latest.json");
  }
  return { version: o.version, macos: o.macos, windows: o.windows };
}

/** URL 白名单：必须以我们的 releases/ 前缀开头。 */
export function isAllowedUpdateUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith(RELEASES_URL_PREFIX);
}

/** 从 `codesign -dv` 的 stderr 里解出 `TeamIdentifier=XXXXXXXXXX`（未签 / 无此行 → null）。 */
export function parseTeamId(codesignDvOutput: string): string | null {
  // 取该行 = 号后到行尾的整段（未签时 codesign 报 `TeamIdentifier=not set`）。
  const m = /TeamIdentifier=(.+)/.exec(codesignDvOutput);
  const tid = m?.[1]?.trim();
  return tid && tid !== "not set" && /^[A-Za-z0-9]+$/.test(tid) ? tid : null;
}

/** sha256 hex。 */
export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface BinaryChecks {
  url: string;
  expectedSha: string;
  actualSha: string;
  /** codesign --verify --strict 通过 */
  codesignVerifyOk: boolean;
  /** codesign -dv 解出的 TeamIdentifier（未签 → null） */
  teamId: string | null;
  expectedTeamId: string;
}

/**
 * 三道硬闸的纯判定：全过才 { ok:true }，任一不过 { ok:false, reason }。
 * fail-closed：expectedTeamId 为空（未编译期注入）→ 拒绝（配置错不能当放行）。
 */
export function validateUpdateBinary(c: BinaryChecks): { ok: boolean; reason?: string } {
  if (!isAllowedUpdateUrl(c.url)) return { ok: false, reason: `url not in releases allowlist: ${c.url}` };
  if (!c.expectedSha || c.actualSha.toLowerCase() !== c.expectedSha.toLowerCase()) {
    return { ok: false, reason: "sha256 mismatch" };
  }
  if (!c.codesignVerifyOk) return { ok: false, reason: "codesign --verify --strict failed" };
  if (!c.expectedTeamId) return { ok: false, reason: "expected Team ID not configured (build without PIE_TEAM_ID)" };
  if (!c.teamId || c.teamId !== c.expectedTeamId) {
    return { ok: false, reason: `TeamIdentifier mismatch (got ${c.teamId ?? "unsigned"}, want ${c.expectedTeamId})` };
  }
  return { ok: true };
}

// ── IO 注入点 ────────────────────────────────────────────────────────

export interface UpdateDeps {
  /** GET → JSON（latest.json） */
  fetchJson: (url: string) => Promise<unknown>;
  /** GET → bytes（更新物 zip） */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** codesign --verify --strict <path> 是否通过 */
  codesignVerify: (binPath: string) => boolean;
  /** codesign -dv <path> 的合并输出（用于解 TeamIdentifier） */
  codesignInfo: (binPath: string) => string;
  /** 解压 zip 到 destDir，返回解出的单个可执行二进制绝对路径 */
  unzipToBinary: (zipPath: string, destDir: string) => string;
  platform: NodeJS.Platform;
  binDir: string;
  expectedTeamId: string;
}

function defaultFetchJson(url: string): Promise<unknown> {
  return fetch(url, { redirect: "follow" }).then((r) => {
    if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
    return r.json();
  });
}
function defaultFetchBytes(url: string): Promise<Uint8Array> {
  return fetch(url, { redirect: "follow" }).then(async (r) => {
    if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  });
}
function defaultCodesignVerify(binPath: string): boolean {
  const r = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binPath], { encoding: "utf8" });
  return r.status === 0;
}
function defaultCodesignInfo(binPath: string): string {
  // codesign -dv 把结果写 stderr；合并 stdout+stderr 再解析。
  const r = spawnSync("/usr/bin/codesign", ["-dv", binPath], { encoding: "utf8" });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}
function defaultUnzipToBinary(zipPath: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, destDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ditto unzip failed: ${r.stderr ?? ""}`);
  // 解出的单个顶层普通文件即二进制（release 打包只放一个 pie-universal）。
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = nodePath.join(dir, d.name);
      if (d.isDirectory()) return d.name === "__MACOSX" ? [] : walk(full);
      return d.name.startsWith(".") ? [] : [full];
    });
  const files = walk(destDir);
  if (files.length === 0) throw new Error("no binary found in update archive");
  // 优先名字含 "pie" 的，否则取最大的文件（二进制远大于任何附带小文件）。
  const pie = files.find((f) => /pie/i.test(nodePath.basename(f)));
  return pie ?? files.sort((a, b) => statSync(b).size - statSync(a).size)[0];
}

function realDeps(): UpdateDeps {
  return {
    fetchJson: defaultFetchJson,
    fetchBytes: defaultFetchBytes,
    codesignVerify: defaultCodesignVerify,
    codesignInfo: defaultCodesignInfo,
    unzipToBinary: defaultUnzipToBinary,
    platform: process.platform,
    binDir: paths.binDir,
    expectedTeamId: EXPECTED_TEAM_ID,
  };
}

// ── RPC 实现 ─────────────────────────────────────────────────────────

/**
 * check_update：拉 latest.json，与 DAEMON_VERSION 比较，回平台对应 URL。
 * Windows 上 supported=false（apply_update 不可用，走安装器），但版本比较照常返回。
 */
export async function checkUpdate(deps: Partial<UpdateDeps> = {}): Promise<CheckUpdateResult> {
  const d = { ...realDeps(), ...deps };
  const latest = parseLatest(await d.fetchJson(LATEST_JSON_URL));
  const current = DAEMON_VERSION;
  const available = compareVersions(latest.version, current) > 0;
  const supported = d.platform === "darwin";
  const url = d.platform === "win32" ? latest.windows.url : latest.macos.url;
  return { current, latest: latest.version, available, url, supported };
}

/**
 * apply_update（仅 macOS）：下载 → 三道硬闸校验 → 原子 rename 覆盖 ~/.pie/bin/pie。
 * 只换文件，**不自己重启**（返回新版本号交调用方 kickstart）。任一校验失败即抛，
 * 现有二进制原封不动。
 */
export async function applyUpdate(deps: Partial<UpdateDeps> = {}): Promise<ApplyUpdateResult> {
  const d = { ...realDeps(), ...deps };
  if (d.platform !== "darwin") {
    throw new Error("self-update not supported on this platform (use the installer)");
  }
  const latest = parseLatest(await d.fetchJson(LATEST_JSON_URL));
  const url = latest.macos.url;
  // 闸 1（URL 白名单）先于任何下载，别把不可信 URL 交给 fetch。
  if (!isAllowedUpdateUrl(url)) throw new Error(`update aborted: url not in releases allowlist: ${url}`);

  const bytes = await d.fetchBytes(url);
  const actualSha = sha256Hex(bytes);

  const work = nodePath.join(tmpdir(), `pie-update-${latest.version}-${actualSha.slice(0, 12)}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const zipPath = nodePath.join(work, "pie.zip");
    writeFileSync(zipPath, bytes);
    const extractDir = nodePath.join(work, "x");
    const binPath = d.unzipToBinary(zipPath, extractDir);
    chmodSync(binPath, 0o755);

    const verdict = validateUpdateBinary({
      url,
      expectedSha: latest.macos.sha256,
      actualSha,
      codesignVerifyOk: d.codesignVerify(binPath),
      teamId: parseTeamId(d.codesignInfo(binPath)),
      expectedTeamId: d.expectedTeamId,
    });
    if (!verdict.ok) throw new Error(`update aborted: ${verdict.reason}`);

    // 原子替换：先 rename 到 binDir 内的临时名（同分区保证 rename 原子），再 rename 覆盖。
    mkdirSync(d.binDir, { recursive: true });
    const target = nodePath.join(d.binDir, "pie");
    const staged = nodePath.join(d.binDir, `pie.new-${actualSha.slice(0, 12)}`);
    const stagedBytes = readFileSync(binPath);
    writeFileSync(staged, stagedBytes);
    chmodSync(staged, 0o755);
    renameSync(staged, target); // 换 inode，老进程继续跑老 inode
    if (existsSync(nodePath.join(d.binDir, "pie.new"))) {
      rmSync(nodePath.join(d.binDir, "pie.new"), { force: true });
    }
    return { version: latest.version, path: target };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
