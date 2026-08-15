/**
 * macOS handoff 唤起：app 走 `open -a`，terminal 走 Terminal + start.command。
 */
import { join } from "path";
import type { DetectedAgent } from "./agents";
import type { SpawnFn } from "./spawn";

export interface DarwinHandoffIO {
  spawn: SpawnFn;
  writeFile: (path: string, content: string, mode?: number) => void;
}

/**
 * do script 注入串的前导牺牲空格数。zsh 启动期的 stdin 消费者（omz 升级提示
 * read -k 1 等）每次吃 1 字符；8 个空格覆盖多个消费者叠加，剩余空格 shell 忽略。
 */
const LAUNCH_PAD = 8;

/** 单引号包裹 + 转义内部单引号。路径来自 which / 文件系统，可能含空格。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function launchFailed(what: string, r: { exitCode: number; stderr?: string }, hint?: string): Error {
  const detail = (r.stderr ?? "").trim().slice(0, 300);
  const core = detail
    ? `failed to open ${what} (exit ${r.exitCode}): ${detail}`
    : `failed to open ${what} (exit ${r.exitCode})`;
  return new Error(hint ? `${core} — ${hint}` : core);
}

export function buildDarwinStartCommand(dir: string, agentPath: string, argv: string[]): string {
  return (
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${shq(agentPath)} ${argv.map(shq).join(" ")}\n`
  );
}

export async function launchDarwinHandoff(
  agent: DetectedAgent,
  dir: string,
  argv: string[],
  io: DarwinHandoffIO,
): Promise<void> {
  if (agent.kind === "app") {
    const r = await io.spawn("open", ["-a", agent.path, dir], dir);
    if (r.exitCode !== 0) {
      throw launchFailed(agent.label, r);
    }
    return;
  }

  // 交互式会话脚本：cd 进目录、用初始 prompt 拉起 CLI。**不带**
  // --dangerously-skip-permissions —— 人就在终端前，agent 自己的交互审批有人可批。
  // dir 是 daemon 派生（homedir + ISO 日期 + slugify 限制字符集在
  // [a-z0-9-]），不含双引号/反引号/`$` 等元字符。
  const script = buildDarwinStartCommand(dir, agent.path, argv);
  const scriptPath = join(dir, "start.command");
  io.writeFile(scriptPath, script, 0o755);
  // 不用 `open start.command`：Terminal 会把脚本路径当键盘输入喂进 login zsh，
  // 启动期 stdin 消费者会吃掉路径首字符。改走 AppleScript do script，前面垫
  // LAUNCH_PAD 个牺牲空格。
  const padded = `${" ".repeat(LAUNCH_PAD)}exec '${scriptPath}'`;
  const r = await io.spawn(
    "osascript",
    ["-e", 'tell application "Terminal"', "-e", `do script "${padded}"`, "-e", "activate", "-e", "end tell"],
    dir,
  );
  if (r.exitCode !== 0) {
    throw launchFailed(
      "a terminal",
      r,
      "grant Automation permission for Pie Link → Terminal in System Settings › Privacy & Security › Automation",
    );
  }
}
