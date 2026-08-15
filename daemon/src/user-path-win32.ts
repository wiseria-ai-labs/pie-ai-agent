/**
 * Windows 用户 PATH / which。env + 注册表合并，`where` 解析（排 WindowsApps stub）。
 */

/**
 * `reg query "<key>" /v Path` 的 stdout 里取 Path 值：命中形如
 * `    Path    REG_EXPAND_SZ    C:\...;C:\...` 的行，取第三列（值）。找不到 → 空串。
 * `REG_SZ` 与 `REG_EXPAND_SZ` 都认（用户 Path 通常 EXPAND，system 视配置而定）。
 */
export function parseRegQueryPath(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/i);
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * Windows PATH 合并（纯函数，可测）：进程 env PATH 打头，再拼注册表 user/system Path，
 * 按 `;` 切段、去空、大小写不敏感去重（Windows 路径大小写不敏感），`;` 重连。
 * 进程 env 优先（当前会话已解析的 PATH 最贴近用户意图），注册表补上未继承进 env 的段。
 */
export function mergeWindowsPath(processPath: string, registryPaths: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [processPath, ...registryPaths]) {
    for (const seg of (src ?? "").split(";")) {
      const t = seg.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out.join(";");
}

/**
 * PATH 真相 = 进程继承的 env PATH ＋ 注册表两处 Path：
 * HKCU\Environment（user）与 HKLM\...\Session Manager\Environment（system）。
 * 注册表读走 `reg query`；任一失败/超时只丢那一段。
 */
export function getWindowsUserPath(): string {
  const processPath = process.env.PATH ?? process.env.Path ?? "";
  const regKeys: string[] = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const registryPaths: string[] = [];
  for (const key of regKeys) {
    try {
      const r = Bun.spawnSync(["reg", "query", key, "/v", "Path"], {
        stdin: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      registryPaths.push(parseRegQueryPath(r.stdout.toString()));
    } catch {
      /* 该注册表段读不到就跳过，靠其余来源兜底 */
    }
  }
  return mergeWindowsPath(processPath, registryPaths);
}

/**
 * Store 执行别名 stub：`%LOCALAPPDATA%\Microsoft\WindowsApps\<name>.exe` 下的 0 字节
 * reparse 占位。`where python` 会把它列在最前，但 spawn 它行为诡异，一律当没装。
 */
export function isWindowsAppsStub(p: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(p);
}

/**
 * `where <bin>` 的 stdout 解析（纯函数，可测）：跳过 WindowsApps stub 和 `.ps1`
 * （spawn 会拉起可见 PowerShell）。同一次输出里优先 `.cmd`/`.exe`/`.bat`
 * （npm 全局常同时放下无扩展 shim + `.cmd` + `.ps1`）。
 */
export function parseWherePath(stdout: string): string | null {
  const hits: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || isWindowsAppsStub(t) || /\.ps1$/i.test(t)) continue;
    hits.push(t);
  }
  return hits.find((p) => /\.(cmd|exe|bat)$/i.test(p)) ?? hits[0] ?? null;
}

/** native host / 托盘拉起的进程经常不带 PATHEXT；`where opencode` 就找不到 npm 的 `.cmd`。 */
const WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS";

export function makeWindowsWhich(userPath: string): (bin: string) => string | null {
  return (bin: string) => {
    try {
      const r = Bun.spawnSync(["where", bin], {
        env: {
          ...process.env,
          PATH: userPath,
          Path: userPath,
          PATHEXT: process.env.PATHEXT || WINDOWS_PATHEXT,
        },
        stdin: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      return parseWherePath(r.stdout.toString());
    } catch {
      return null;
    }
  };
}
