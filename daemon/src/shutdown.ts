/**
 * 语义退出：客户端发 `shutdown`，runtime 自己卸 KeepAlive / 结束进程。
 * 接口不得靠 pid 杀（ADR 0010）。
 */

export interface ShutdownHooks {
  afterMs?: number;
  exit?: (code: number) => void;
  unloadKeepAlive?: () => void;
}

let scheduled = false;

/** 测试用：允许同一进程里再排一次。 */
export function __resetShutdownForTests(): void {
  scheduled = false;
}

function defaultUnloadKeepAlive(): void {
  if (process.platform !== "darwin") return;
  const uid = process.getuid?.();
  if (uid == null) return;
  try {
    Bun.spawnSync(["/bin/launchctl", "bootout", `gui/${uid}/ai.wiseria.pie`], {
      stdin: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
  } catch {
    /* 无 launchd job（例如手动 pie daemon） */
  }
}

/** 先让 RPC 回包，再卸常驻并退出。重复调用幂等。 */
export function scheduleDaemonStop(hooks: ShutdownHooks = {}): void {
  if (scheduled) return;
  scheduled = true;
  const exit = hooks.exit ?? ((code: number) => process.exit(code));
  const unload = hooks.unloadKeepAlive ?? defaultUnloadKeepAlive;
  setTimeout(() => {
    try {
      unload();
    } catch {
      /* best-effort */
    }
    exit(0);
  }, hooks.afterMs ?? 50);
}
