/**
 * Windows skill 沙箱附属：cmd 引号 / env 内联、srt-win 路径、WFP 就绪探针。
 * 产品路径已改 passthrough（selectSkillSandbox），这些留给测试与若再启用 srt-win。
 */
import { resolveSrtWin, verifyWindowsWfpEgress } from "@anthropic-ai/sandbox-runtime";
import { dirname, join } from "path";

export function srtWinPath(): string {
  return join(dirname(process.execPath), "srt-win.exe");
}

export function cmdQuote(argv: string[]): string {
  return argv.map((a) => `"${a.replace(/"/g, `""`)}"`).join(" ");
}

export function cmdEnvPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `set "${k}=${v}" && `)
    .join("");
}

export function buildWindowsCommand(argv: string[], env: Record<string, string>): string {
  return cmdEnvPrefix(env) + cmdQuote(argv);
}

export async function checkWindowsSandboxReady(): Promise<{ ready: boolean; reason?: string }> {
  try {
    await verifyWindowsWfpEgress({ srtWin: resolveSrtWin({ path: srtWinPath() }) });
    return { ready: true };
  } catch (e) {
    return { ready: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 给若再启用 srt-win 用：broker env = process.env + wrapped.env。 */
export function windowsBrokerEnv(
  procEnv: Record<string, string | undefined>,
  wrappedEnv: Record<string, string>,
): Record<string, string | undefined> {
  return { ...procEnv, ...wrappedEnv };
}
