/**
 * macOS agent 检测。只认 /Applications bundle 与 which / binPaths。
 * 不读 Windows Uninstall / Appx，也不看候选表上的 uninstall* / appx* 字段。
 */
import { homedir } from "os";
import type { AgentCandidate, DetectedAgent } from "./agents";

export function detectDarwinAgents(
  candidates: readonly AgentCandidate[],
  exists: (path: string) => boolean,
  which: (bin: string) => string | null,
): DetectedAgent[] {
  const out: DetectedAgent[] = [];
  for (const c of candidates) {
    const path =
      c.kind === "app"
        ? (c.appPaths!.map((p) => p.replace(/^~/, homedir())).find((p) => exists(p)) ?? null)
        : (which(c.bin!) ??
          c.binPaths?.map((p) => p.replace(/^~/, homedir())).find((p) => exists(p)) ??
          null);
    if (path) out.push({ ...c, path });
  }
  return out;
}
