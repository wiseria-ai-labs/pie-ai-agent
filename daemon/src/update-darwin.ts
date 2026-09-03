/**
 * macOS apply_update：codesign 三闸 + ditto 解压 + 原子 rename。
 * #419：daemon 二进制换完后，再整体替换 /Applications/Pie Link.app（失败不回滚 daemon）。
 */
import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync, existsSync, chmodSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import nodePath from "path";
import type { PieLinkLatest, ApplyUpdateResult } from "../../src/types/local-bridge";
import {
  isAllowedUpdateUrl,
  sha256Hex,
  parseTeamId,
  validateUpdateBinary,
  PIE_LINK_APP_PATH,
  type UpdateDeps,
} from "./update-core";

export function defaultCodesignVerify(binPath: string): boolean {
  const r = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binPath], { encoding: "utf8" });
  return r.status === 0;
}

/** bundle 必须 --deep，否则只验外层封套、内嵌 Mach-O 被掉包也过。 */
export function defaultCodesignVerifyDeep(bundlePath: string): boolean {
  const r = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundlePath], { encoding: "utf8" });
  return r.status === 0;
}

export function defaultCodesignInfo(binPath: string): string {
  const r = spawnSync("/usr/bin/codesign", ["-dv", binPath], { encoding: "utf8" });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

export function defaultUnzipToBinary(zipPath: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, destDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ditto unzip failed: ${r.stderr ?? ""}`);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = nodePath.join(dir, d.name);
      if (d.isDirectory()) return d.name === "__MACOSX" ? [] : walk(full);
      return d.name.startsWith(".") ? [] : [full];
    });
  const files = walk(destDir);
  if (files.length === 0) throw new Error("no binary found in update archive");
  const pie = files.find((f) => /pie/i.test(nodePath.basename(f)));
  return pie ?? files.sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
}

/**
 * 顶层唯一 `.app` 目录。不递归——`defaultUnzipToBinary` 的 walk 会钻进 Contents/MacOS
 * 把里面的 Mach-O 当成「二进制」返回。跳过 `__MACOSX` 与点文件。
 */
export function findTopLevelApp(dir: string): string {
  const apps = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith(".app") && !d.name.startsWith(".") && d.name !== "__MACOSX")
    .map((d) => nodePath.join(dir, d.name));
  if (apps.length === 0) throw new Error("no .app bundle found in update archive");
  return apps.find((a) => nodePath.basename(a) === "Pie Link.app") ?? apps[0]!;
}

export function defaultUnzipToBundle(zipPath: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, destDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ditto unzip failed: ${r.stderr ?? ""}`);
  return findTopLevelApp(destDir);
}

function rmForce(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * 把已验签的 bundle 原子换到 appPath。temps 与 app 同目录（同分区，避 EXDEV）。
 * finally 无条件清 `.pie-update-*` / `.pie-new` / `.pie-old`；若换到一半 live 丢了，先从 `.pie-old` 还原。
 */
function swapAppBundle(bundlePath: string, appPath: string, appsDir: string): void {
  const newPath = nodePath.join(appsDir, ".pie-new");
  const oldPath = nodePath.join(appsDir, ".pie-old");
  rmForce(newPath);
  rmForce(oldPath);
  renameSync(bundlePath, newPath);
  if (existsSync(appPath)) renameSync(appPath, oldPath);
  try {
    renameSync(newPath, appPath);
  } catch (e) {
    if (existsSync(oldPath) && !existsSync(appPath)) {
      try {
        renameSync(oldPath, appPath);
      } catch {
        /* restore best-effort；finally 再兜一次 */
      }
    }
    throw e;
  }
  rmForce(oldPath);
}

function cleanupAppTemps(appsDir: string, updateDir: string | null, appPath: string): void {
  if (updateDir) rmForce(updateDir);
  rmForce(nodePath.join(appsDir, ".pie-new"));
  const oldPath = nodePath.join(appsDir, ".pie-old");
  if (existsSync(appPath)) {
    rmForce(oldPath);
  } else if (existsSync(oldPath)) {
    try {
      renameSync(oldPath, appPath);
    } catch {
      /* last-ditch restore */
    }
    if (existsSync(appPath)) rmForce(oldPath);
  }
}

/**
 * daemon 已换成功之后跑。整段 try/catch：任何失败只记 appUpdated:false + appError，不抛、不回滚 daemon。
 * 无 `app` 字段 = 老 json，静默跳过（不报错）。
 */
async function applyAppBundleUpdate(
  d: UpdateDeps,
  latest: PieLinkLatest,
  daemon: { version: string; path: string },
): Promise<ApplyUpdateResult> {
  if (!latest.app) return { ...daemon, appUpdated: false };

  const appPath = d.appPath || PIE_LINK_APP_PATH;
  const appsDir = nodePath.dirname(appPath);
  let updateDir: string | null = null;
  try {
    const appUrl = latest.app.url;
    if (!isAllowedUpdateUrl(appUrl)) {
      throw new Error(`url not in releases allowlist: ${appUrl}`);
    }
    const bytes = await d.fetchBytes(appUrl);
    const actualSha = sha256Hex(bytes);
    updateDir = nodePath.join(appsDir, `.pie-update-${actualSha.slice(0, 12)}`);
    rmForce(updateDir);
    mkdirSync(updateDir, { recursive: true });
    const zipPath = nodePath.join(updateDir, "app.zip");
    writeFileSync(zipPath, bytes);
    const bundlePath = d.unzipToBundle(zipPath, updateDir);
    const verdict = validateUpdateBinary({
      url: appUrl,
      expectedSha: latest.app.sha256,
      actualSha,
      codesignVerifyOk: d.codesignVerifyDeep(bundlePath),
      teamId: parseTeamId(d.codesignInfo(bundlePath)),
      expectedTeamId: d.expectedTeamId,
    });
    if (!verdict.ok) throw new Error(`update aborted: ${verdict.reason}`);
    swapAppBundle(bundlePath, appPath, appsDir);
    return { ...daemon, appUpdated: true };
  } catch (e) {
    const appError = e instanceof Error ? e.message : String(e);
    return { ...daemon, appUpdated: false, appError };
  } finally {
    cleanupAppTemps(appsDir, updateDir, appPath);
  }
}

/** 下载 macos 通道 zip → 验签 → 原子覆盖 binDir/pie。不自己重启。成功后再尝试换 app bundle。 */
export async function applyDarwinUpdate(d: UpdateDeps, latest: PieLinkLatest): Promise<ApplyUpdateResult> {
  const url = latest.macos.url;
  if (!isAllowedUpdateUrl(url)) throw new Error(`update aborted: url not in releases allowlist: ${url}`);

  const bytes = await d.fetchBytes(url);
  const actualSha = sha256Hex(bytes);

  const work = nodePath.join(tmpdir(), `pie-update-${latest.version}-${actualSha.slice(0, 12)}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  let daemonResult: { version: string; path: string };
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

    mkdirSync(d.binDir, { recursive: true });
    const target = nodePath.join(d.binDir, "pie");
    const staged = nodePath.join(d.binDir, `pie.new-${actualSha.slice(0, 12)}`);
    writeFileSync(staged, readFileSync(binPath));
    chmodSync(staged, 0o755);
    renameSync(staged, target);
    if (existsSync(nodePath.join(d.binDir, "pie.new"))) {
      rmSync(nodePath.join(d.binDir, "pie.new"), { force: true });
    }
    daemonResult = { version: latest.version, path: target };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return applyAppBundleUpdate(d, latest, daemonResult);
}
