/**
 * Windows 已装 GUI 的权威源：Uninstall 注册表（HKCU / HKLM / WOW6432Node）。
 * DisplayName 精确匹配（大小写不敏感），再用 DisplayIcon / InstallLocation 解出 .exe。
 * 不扫开始菜单；拒绝 Parallels `\\Mac\` / Shared Applications / WindowsApps 版本目录。
 */

export type UninstallEntry = {
  displayName: string;
  installLocation: string;
  displayIcon: string;
};

const UNINSTALL_ROOTS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const;

/** DisplayIcon 常见 `C:\...\App.exe,0`；剥引号和 icon index。 */
export function normalizeDisplayIcon(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    s = end > 0 ? s.slice(1, end) : s.slice(1);
  }
  return s.replace(/,\d+$/, "").trim();
}

export function isRejectedWinAppPath(p: string): boolean {
  const n = p.replace(/\//g, "\\");
  if (/^[a-z]:\\Mac\\/i.test(n) || n.startsWith("\\\\Mac\\") || /^\\\\Mac\\/i.test(n)) return true;
  if (/Shared Applications/i.test(n)) return true;
  if (/\\WindowsApps\\/i.test(n)) return true;
  return false;
}

function basename(p: string): string {
  const n = p.replace(/\//g, "\\");
  const i = n.lastIndexOf("\\");
  return i >= 0 ? n.slice(i + 1) : n;
}

function joinDir(dir: string, file: string): string {
  const d = dir.replace(/[\\/]+$/, "");
  return `${d}\\${file}`;
}

/** 从一条 Uninstall 记录解出候选 exe（尚未 exists）。 */
export function exeFromUninstallEntry(entry: UninstallEntry, exes: readonly string[]): string | null {
  const want = new Set(exes.map((e) => e.toLowerCase()));
  const icon = normalizeDisplayIcon(entry.displayIcon);
  if (icon && want.has(basename(icon).toLowerCase()) && !isRejectedWinAppPath(icon)) return icon;
  const loc = entry.installLocation.trim().replace(/^"|"$/g, "");
  if (!loc || isRejectedWinAppPath(loc)) return null;
  for (const exe of exes) {
    const p = joinDir(loc, exe);
    if (!isRejectedWinAppPath(p)) return p;
  }
  return null;
}

export function resolveUninstallApp(
  entries: readonly UninstallEntry[],
  names: readonly string[],
  exes: readonly string[],
  exists: (path: string) => boolean,
): string | null {
  if (names.length === 0 || exes.length === 0) return null;
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const e of entries) {
    if (!want.has(e.displayName.trim().toLowerCase())) continue;
    const path = exeFromUninstallEntry(e, exes);
    if (path && exists(path)) return path;
  }
  return null;
}

/** 解析 `reg query ... /s` 的多 key 块。 */
export function parseRegQueryDump(stdout: string): UninstallEntry[] {
  const out: UninstallEntry[] = [];
  let cur: { displayName: string; installLocation: string; displayIcon: string } | null = null;
  const flush = () => {
    if (cur && cur.displayName) out.push(cur);
    cur = null;
  };
  for (const raw of stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(raw)) {
      flush();
      cur = { displayName: "", installLocation: "", displayIcon: "" };
      continue;
    }
    if (!cur) continue;
    const m = raw.match(/^\s+(\S+)\s+REG_\S+\s+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "displayname") cur.displayName = val;
    else if (key === "installlocation") cur.installLocation = val;
    else if (key === "displayicon") cur.displayIcon = val;
  }
  flush();
  return out;
}

export function listWindowsUninstall(): UninstallEntry[] {
  const out: UninstallEntry[] = [];
  for (const root of UNINSTALL_ROOTS) {
    try {
      const r = Bun.spawnSync(["reg", "query", root, "/s"], {
        stdin: "ignore",
        timeout: 8000,
        windowsHide: true,
      });
      if (r.exitCode !== 0) continue;
      out.push(...parseRegQueryDump(r.stdout.toString()));
    } catch {
      /* hive 不存在 / reg 不可用 */
    }
  }
  return out;
}
