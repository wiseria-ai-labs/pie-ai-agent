import { existsSync } from "fs";
import { paths } from "./paths";
import { detectAgents, type DetectedAgent } from "./agents";
import type { DoctorCheck } from "./windows-doctor";

export async function doctor(
  // 注入点统一收在一个 opts 里：
  // - detect：agent 探测，默认走 detectAgents（真机要问 login shell PATH）；
  // - windowsChecks：Windows 检查项，默认走真机 doctor（reg query / net use / srt 探针），
  //   非 win32 跳过；测试传桩在 mac/linux 上覆盖 win32 分支做 hermetic 断言。
  opts: {
    platform?: NodeJS.Platform;
    detect?: () => DetectedAgent[];
    windowsChecks?: () => Promise<{ ok: boolean; lines: string[]; checks?: DoctorCheck[] }>;
  } = {},
): Promise<{ ok: boolean; lines: string[]; checks: DoctorCheck[] }> {
  const platform = opts.platform ?? process.platform;
  const lines: string[] = [];
  // Structured checks for `pie doctor --json` (#406). Only the Windows tray consumes these, so the
  // array is empty on non-win32 (the human-readable `lines` are the sole cross-platform contract).
  let checks: DoctorCheck[] = [];
  // named pipe 不在文件系统命名空间，existsSync 无法反映 daemon 是否在跑——只报地址、
  // 不做在场判定；ok 在 pipe 平台不把 IPC 在场性算进去（避免误报「未运行」）。
  const ipcPresent = paths.isPipe ? null : existsSync(paths.ipcPath);
  lines.push(ipcStatusLine(paths.ipcPath, paths.isPipe, ipcPresent));

  // 与 handoff / 设置页同一个真源（detectAgents）：login shell PATH（Windows 走 env+注册表）、
  // binPaths 回落、全部候选。裸 Bun.which("claude") 在 menubar app 这类 launchd 上下文里
  // 必然 miss（PATH 只有 /usr/bin:/bin:...），报的是环境差异不是故障。
  let agents: DetectedAgent[] = [];
  try {
    agents = (opts.detect ?? detectAgents)();
  } catch {
    /* 探测失败（shell 超时等）不该拖垮 doctor 的其余检查 */
  }
  lines.push(
    agents.length
      ? `agents: ${agents.map((a) => `${a.id} → ${a.path}`).join(", ")}`
      : "agents: none detected",
  );

  // ok = daemon 健康度，与「装没装 agent」无关：只用 codex/cursor 的用户不该恒 exit 1。
  // pipe 平台无法 fs 判在场（ipcPresent=null）→ 不拿它压 ok。
  let ok = ipcPresent ?? true;

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
    checks = win.checks ?? [];
  }

  return { ok, lines, checks };
}

function ipcStatusLine(ipcPath: string, isPipe: boolean, present: boolean | null): string {
  if (isPipe) return `pipe ${ipcPath}: (existence not fs-checkable on Windows)`;
  return `socket ${ipcPath}: ${present ? "present" : "absent (daemon not running?)"}`;
}
