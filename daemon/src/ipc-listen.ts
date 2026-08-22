/**
 * daemon listen 前的 IPC 占用处理。按 paths.isPipe 分，不按 platform 名。
 */
import { existsSync, unlinkSync, chmodSync } from "fs";
import type { Paths } from "./paths";

/** unix socket 探活上限：连上即有活体；ECONNREFUSED / 超时当陈尸。 */
const UNIX_PROBE_TIMEOUT_MS = 500;

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

async function unixSocketAlreadyServed(ipcPath: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pipeAlreadyServed(ipcPath),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), UNIX_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function claimIpc(p: Paths): Promise<"already_running" | "ready"> {
  if (p.isPipe) {
    if (await pipeAlreadyServed(p.ipcPath)) return "already_running";
    return "ready";
  }
  // unix socket：Bun/uSockets 会先 unlink 再 bind，听不到 EADDRINUSE。
  // 文件在就先探活——连上把地盘让给现有实例；连不上才清陈尸。
  if (existsSync(p.ipcPath)) {
    if (await unixSocketAlreadyServed(p.ipcPath)) return "already_running";
    unlinkSync(p.ipcPath);
  }
  return "ready";
}

export function hardenIpc(p: Paths): void {
  if (!p.isPipe) chmodSync(p.ipcPath, 0o600);
}
