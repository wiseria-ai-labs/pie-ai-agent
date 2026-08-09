import { existsSync } from "fs";
import { paths } from "./paths";
import { listSkillsMerged } from "./skill-store";
import type { SkillSummary } from "../../src/types/local-bridge";

export async function doctor(
  // 注入点：默认扫真实两根，测试可传桩清单做 hermetic 断言。
  listSkills: () => SkillSummary[] = listSkillsMerged,
  // Windows 检查项注入点：默认走真机 doctor（reg query / net use / srt 探针），非 win32 跳过；
  // 测试传桩在 mac/linux 上覆盖 win32 分支做 hermetic 断言。
  opts: {
    platform?: NodeJS.Platform;
    windowsChecks?: () => Promise<{ ok: boolean; lines: string[] }>;
  } = {},
): Promise<{ ok: boolean; lines: string[] }> {
  const platform = opts.platform ?? process.platform;
  const lines: string[] = [];
  // named pipe 不在文件系统命名空间，existsSync 无法反映 daemon 是否在跑——只报地址、
  // 不做在场判定；ok 在 pipe 平台不把 IPC 在场性算进去（避免误报「未运行」）。
  const ipcPresent = paths.isPipe ? null : existsSync(paths.ipcPath);
  if (paths.isPipe) {
    lines.push(`pipe ${paths.ipcPath}: (existence not fs-checkable on Windows)`);
  } else {
    lines.push(`socket ${paths.ipcPath}: ${ipcPresent ? "present" : "absent (daemon not running?)"}`);
  }
  const claude = Bun.which("claude");
  lines.push(`claude CLI: ${claude ?? "NOT FOUND on PATH"}`);

  // skill 网络声明健康检查：列出被安全丢弃的非法域名（作者信号；不影响 ok，
  // 断网是安全兜底而非故障）。
  let skills: SkillSummary[] = [];
  try {
    skills = listSkills();
  } catch {
    /* 扫 skill 失败不该拖垮 doctor 的核心检查 */
  }
  for (const s of skills) {
    if (s.invalidNetwork && s.invalidNetwork.length > 0) {
      lines.push(`skill "${s.name}": ${s.invalidNetwork.length} invalid network domain(s) ignored: ${s.invalidNetwork.join(", ")}`);
    }
  }

  // pipe 平台无法 fs 判在场（ipcPresent=null）→ 不拿它压 ok，只看 claude CLI。
  let ok = (ipcPresent ?? true) && claude != null;

  // Windows 专属检查项（F1/F5/F6 + NM 注册表 HKCU 遮蔽）。非 win32 整体跳过——不产生噪音输出
  // （沿用 doctor 平台分支惯例）。
  if (platform === "win32") {
    const runWin =
      opts.windowsChecks ??
      (async () => {
        const { runWindowsDoctor } = await import("./windows-doctor");
        return runWindowsDoctor();
      });
    const win = await runWin();
    lines.push(...win.lines);
    ok = ok && win.ok;
  }

  return { ok, lines };
}
