/**
 * macOS apply_update：codesign 三闸 + ditto 解压 + 原子 rename。
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
  type UpdateDeps,
} from "./update-core";

export function defaultCodesignVerify(binPath: string): boolean {
  const r = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binPath], { encoding: "utf8" });
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

/** 下载 macos 通道 zip → 验签 → 原子覆盖 binDir/pie。不自己重启。 */
export async function applyDarwinUpdate(d: UpdateDeps, latest: PieLinkLatest): Promise<ApplyUpdateResult> {
  const url = latest.macos.url;
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

    mkdirSync(d.binDir, { recursive: true });
    const target = nodePath.join(d.binDir, "pie");
    const staged = nodePath.join(d.binDir, `pie.new-${actualSha.slice(0, 12)}`);
    writeFileSync(staged, readFileSync(binPath));
    chmodSync(staged, 0o755);
    renameSync(staged, target);
    if (existsSync(nodePath.join(d.binDir, "pie.new"))) {
      rmSync(nodePath.join(d.binDir, "pie.new"), { force: true });
    }
    return { version: latest.version, path: target };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
