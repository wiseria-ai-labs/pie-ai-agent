/**
 * Windows Store / MSIX 包：AppModel 仓库注册表。
 * Uninstall 键没有 ChatGPT 桌面（OpenAI.Codex），但
 * `...\AppModel\Repository\Packages\OpenAI.Codex_*` 有 PackageRootFolder。
 * 不扫开始菜单；只认候选表声明的 package 前缀。
 */

export type AppxPackage = {
  id: string;
  root: string;
};

const APPX_PACKAGE_ROOTS = [
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages",
  "HKLM\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages",
] as const;

export function parseRegKeyLines(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^HKEY_/i.test(t)) out.push(t);
  }
  return out;
}

export function parseRegSzValue(stdout: string, name: string): string | null {
  const want = name.toLowerCase();
  for (const raw of stdout.split(/\r?\n/)) {
    const m = raw.match(/^\s+(\S+)\s+REG_SZ\s+(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === want) {
      const v = m[2].trim();
      return v || null;
    }
  }
  return null;
}

function joinRoot(root: string, rel: string): string {
  const d = root.replace(/[\\/]+$/, "");
  const r = rel.replace(/^[\\/]+/, "").replace(/\//g, "\\");
  return `${d}\\${r}`;
}

export function resolveAppxApp(
  packages: readonly AppxPackage[],
  prefix: string,
  relExes: readonly string[],
  exists: (path: string) => boolean,
): string | null {
  if (!prefix || relExes.length === 0) return null;
  const head = `${prefix.toLowerCase()}_`;
  for (const pkg of packages) {
    const id = pkg.id.toLowerCase();
    if (id !== prefix.toLowerCase() && !id.startsWith(head)) continue;
    for (const rel of relExes) {
      const p = joinRoot(pkg.root, rel);
      if (exists(p)) return p;
    }
  }
  return null;
}

function packageIdFromKey(key: string): string {
  const i = key.lastIndexOf("\\");
  return i >= 0 ? key.slice(i + 1) : key;
}

export function listWindowsAppx(prefixes: readonly string[]): AppxPackage[] {
  if (prefixes.length === 0) return [];
  const out: AppxPackage[] = [];
  const seen = new Set<string>();
  for (const root of APPX_PACKAGE_ROOTS) {
    for (const prefix of prefixes) {
      try {
        const listed = Bun.spawnSync(["reg", "query", root, "/f", prefix, "/k"], {
          stdin: "ignore",
          timeout: 4000,
          windowsHide: true,
        });
        if (listed.exitCode !== 0) continue;
        for (const key of parseRegKeyLines(listed.stdout.toString())) {
          const id = packageIdFromKey(key);
          if (seen.has(id.toLowerCase())) continue;
          const vals = Bun.spawnSync(["reg", "query", key, "/v", "PackageRootFolder"], {
            stdin: "ignore",
            timeout: 3000,
            windowsHide: true,
          });
          if (vals.exitCode !== 0) continue;
          const folder = parseRegSzValue(vals.stdout.toString(), "PackageRootFolder");
          if (!folder) continue;
          seen.add(id.toLowerCase());
          out.push({ id, root: folder });
        }
      } catch {
        /* hive / reg 不可用 */
      }
    }
  }
  return out;
}
