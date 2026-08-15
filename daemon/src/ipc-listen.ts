/**
 * daemon listen 前的 IPC 占用处理。按 paths.isPipe 分，不按 platform 名。
 */
import { existsSync, unlinkSync, chmodSync } from "fs";
import type { Paths } from "./paths";

/**
 * 抢 pipe 前先探一手：连得上说明已有 daemon 在服务这条 pipe，本进程让位。
 * Windows named pipe 被占时 Bun 可能 panic 而非抛 EADDRINUSE。
 */
export async function pipeAlreadyServed(ipcPath: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: ipcPath, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export async function claimIpc(p: Paths): Promise<"already_running" | "ready"> {
  if (p.isPipe) {
    if (await pipeAlreadyServed(p.ipcPath)) return "already_running";
    return "ready";
  }
  if (existsSync(p.ipcPath)) unlinkSync(p.ipcPath);
  return "ready";
}

export function hardenIpc(p: Paths): void {
  if (!p.isPipe) chmodSync(p.ipcPath, 0o600);
}
