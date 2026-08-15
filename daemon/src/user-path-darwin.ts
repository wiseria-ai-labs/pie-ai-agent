/**
 * macOS 用户 PATH / which。问 login shell 要真相（launchd 裸 PATH 看不见 brew / ~/.local/bin）。
 */

/**
 * shell 输出里取 PATH：只认最后一个非空行。rc 里的 banner / 提示会先打出来，
 * 真正的 `echo $PATH` 永远在最后。空输出（shell 挂了 / 超时）回落 fallback。
 */
export function parseShellPath(stdout: string, fallback: string): string {
  const last = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  return last || fallback;
}

/**
 * daemon 跑在 launchd 下，PATH 是裸的 /usr/bin:/bin:/usr/sbin:/sbin。
 * 问用户自己的 login shell 要真相。
 *
 * stdin: "ignore" —— 防 zsh 启动期读 stdin 的东西把探测挂死。
 * timeout 3000 —— 超时宁可检测不到，也不能卡住授权卡。
 */
export function getDarwinUserPath(): string {
  const fallback = process.env.PATH ?? "";
  try {
    const r = Bun.spawnSync([process.env.SHELL ?? "/bin/zsh", "-lic", "echo $PATH"], {
      stdin: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
    return parseShellPath(r.stdout.toString(), fallback);
  } catch {
    return fallback;
  }
}

export function makeDarwinWhich(userPath: string): (bin: string) => string | null {
  return (b: string) => Bun.which(b, { PATH: userPath });
}
