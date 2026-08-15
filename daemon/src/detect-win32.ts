/**
 * Windows agent 检测。app：Uninstall 注册表 → AppModel（Store/MSIX）→ appPaths。
 * terminal：where → binPaths。不跑 mac login-shell PATH，不认 /Applications。
 */
import { homedir } from "os";
import type { AgentCandidate, DetectedAgent } from "./agents";
import { resolveUninstallApp, type UninstallEntry } from "./windows-uninstall";
import { resolveAppxApp, type AppxPackage } from "./windows-appx";

export function detectWindowsAgents(
  candidates: readonly AgentCandidate[],
  exists: (path: string) => boolean,
  which: (bin: string) => string | null,
  uninstall: readonly UninstallEntry[],
  appx: readonly AppxPackage[],
): DetectedAgent[] {
  const out: DetectedAgent[] = [];
  for (const c of candidates) {
    const path =
      c.kind === "app"
        ? (resolveUninstallApp(uninstall, c.uninstallNames ?? [], c.uninstallExes ?? [], exists) ??
          resolveAppxApp(appx, c.appxPackagePrefix ?? "", c.appxRelExes ?? [], exists) ??
          c.appPaths!.map((p) => p.replace(/^~/, homedir())).find(
            (p) => !p.startsWith("/Applications/") && !p.endsWith(".app") && exists(p),
          ) ??
          null)
        : (which(c.bin!) ??
          c.binPaths?.map((p) => p.replace(/^~/, homedir())).find((p) => exists(p)) ??
          null);
    if (path) out.push({ ...c, path });
  }
  return out;
}
