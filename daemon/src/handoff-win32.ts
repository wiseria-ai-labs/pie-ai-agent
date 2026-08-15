/**
 * Windows handoff 唤起：app 走 `cmd /c start`，terminal 走 start.bat / Windows Terminal。
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { DetectedAgent } from "./agents";
import type { SpawnFn } from "./spawn";

export interface Win32HandoffIO {
  spawn: SpawnFn;
  writeFile: (path: string, content: string, mode?: number) => void;
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
}

/** cmd.exe 双引号转义：`"` → `""`。 */
export function batQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildWindowsStartBat(dir: string, agentPath: string, argv: string[]): string {
  return [
    "@echo off",
    `cd /d ${batQuote(dir)} || exit /b 1`,
    [batQuote(agentPath), ...argv.map(batQuote)].join(" "),
    "",
  ].join("\r\n");
}

/**
 * Windows 版打开 GUI：`cmd /c start "" <exe> <dir>`。
 * 必须走 `start` 再 detach——realSpawn 带 windowsHide，直接 spawn .exe 会把 GUI 藏掉。
 * 空格路径由 spawn 的 argv quoting 处理（跟 windowsHandoffSpawn 同一契约，不要 batQuote）。
 */
export function windowsOpenApp(exe: string, dir: string): { cmd: string; args: string[] } {
  return { cmd: "cmd.exe", args: ["/c", "start", "", exe, dir] };
}

/**
 * 外层 `cmd /c start` 可以 windowsHide——`start` 会另开可见窗。
 * 有 wt 则 `start "" wt -d dir cmd /c start.bat`，否则 `start "" /D dir cmd /c start.bat`。
 */
export function windowsHandoffSpawn(
  dir: string,
  scriptPath: string,
  wtPath: string | null,
): { cmd: string; args: string[] } {
  if (wtPath) {
    return { cmd: "cmd.exe", args: ["/c", "start", "", wtPath, "-d", dir, "cmd.exe", "/c", scriptPath] };
  }
  return { cmd: "cmd.exe", args: ["/c", "start", "", "/D", dir, "cmd.exe", "/c", scriptPath] };
}

const WT_WELL_KNOWN = ["AppData/Local/Microsoft/WindowsApps/wt.exe", "AppData/Local/Microsoft/Windows Terminal/wt.exe"];

/** 给 wt 用：WindowsApps 别名算命中（与 detectAgents 的 stub 过滤相反）。 */
function defaultWhere(bin: string): string | null {
  try {
    const r = Bun.spawnSync(["where", bin], {
      stdin: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
    for (const line of r.stdout.toString().split(/\r?\n/)) {
      const t = line.trim();
      if (t) return t;
    }
    return null;
  } catch {
    return null;
  }
}

/** wt 的 WindowsApps 别名是真入口（不像 Store python stub），允许命中。 */
export function resolveWindowsTerminal(opts?: {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
  home?: string;
}): string | null {
  const which = opts?.which;
  const exists = opts?.exists ?? existsSync;
  const home = opts?.home ?? homedir();
  const fromWhere = which?.("wt.exe") ?? which?.("wt");
  if (fromWhere) return fromWhere;
  for (const rel of WT_WELL_KNOWN) {
    const p = join(home, ...rel.split("/"));
    if (exists(p)) return p;
  }
  return null;
}

function launchFailed(what: string, r: { exitCode: number; stderr?: string }): Error {
  const detail = (r.stderr ?? "").trim().slice(0, 300);
  return new Error(
    detail
      ? `failed to open ${what} (exit ${r.exitCode}): ${detail}`
      : `failed to open ${what} (exit ${r.exitCode})`,
  );
}

export async function launchWin32Handoff(
  agent: DetectedAgent,
  dir: string,
  argv: string[],
  io: Win32HandoffIO,
): Promise<void> {
  if (agent.kind === "app") {
    const launch = windowsOpenApp(agent.path, dir);
    const r = await io.spawn(launch.cmd, launch.args, dir);
    if (r.exitCode !== 0) throw launchFailed(agent.label, r);
    return;
  }

  const scriptPath = join(dir, "start.bat");
  io.writeFile(scriptPath, buildWindowsStartBat(dir, agent.path, argv));
  const wtPath = resolveWindowsTerminal({
    which: io.which ?? defaultWhere,
    exists: io.exists,
  });
  const launch = windowsHandoffSpawn(dir, scriptPath, wtPath);
  const r = await io.spawn(launch.cmd, launch.args, dir);
  if (r.exitCode !== 0) throw launchFailed("a terminal", r);
}
