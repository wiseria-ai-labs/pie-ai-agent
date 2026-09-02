/** 更新协议侧纯逻辑 + 跨平台 fetch。平台 IO 不住这里。 */
import { createHash } from "crypto";
import type { PieLinkLatest } from "../../src/types/local-bridge";

export const LATEST_JSON_URL =
  "https://github.com/wiseria-ai-labs/pie-ai-agent/releases/latest/download/pie-link-latest.json";

export const RELEASES_URL_PREFIX = "https://github.com/wiseria-ai-labs/pie-ai-agent/releases/";

export const EXPECTED_TEAM_ID: string = process.env.PIE_TEAM_ID || "";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function parseLatest(raw: unknown): PieLinkLatest {
  const o = raw as Partial<PieLinkLatest> | null;
  const okPlat = (p: unknown): p is { url: string; sha256: string } =>
    !!p && typeof (p as { url?: unknown }).url === "string" && typeof (p as { sha256?: unknown }).sha256 === "string";
  if (!o || typeof o.version !== "string" || !okPlat(o.macos) || !okPlat(o.windows)) {
    throw new Error("malformed pie-link-latest.json");
  }
  const latest: PieLinkLatest = { version: o.version, macos: o.macos, windows: o.windows };
  // #419：app 缺省合法（老 json）；存在则必须是 {url, sha256}，否则抛。其它未知字段忽略。
  if ("app" in o && o.app !== undefined) {
    if (!okPlat(o.app)) throw new Error("malformed pie-link-latest.json");
    latest.app = o.app;
  }
  return latest;
}

export function isAllowedUpdateUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith(RELEASES_URL_PREFIX);
}

export function parseTeamId(codesignDvOutput: string): string | null {
  const m = /TeamIdentifier=(.+)/.exec(codesignDvOutput);
  const tid = m?.[1]?.trim();
  return tid && tid !== "not set" && /^[A-Za-z0-9]+$/.test(tid) ? tid : null;
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface BinaryChecks {
  url: string;
  expectedSha: string;
  actualSha: string;
  codesignVerifyOk: boolean;
  teamId: string | null;
  expectedTeamId: string;
}

export function validateUpdateBinary(c: BinaryChecks): { ok: boolean; reason?: string } {
  if (!isAllowedUpdateUrl(c.url)) return { ok: false, reason: `url not in releases allowlist: ${c.url}` };
  if (!c.expectedSha || c.actualSha.toLowerCase() !== c.expectedSha.toLowerCase()) {
    return { ok: false, reason: "sha256 mismatch" };
  }
  if (!c.codesignVerifyOk) return { ok: false, reason: "codesign --verify --strict failed" };
  if (!c.expectedTeamId) return { ok: false, reason: "expected Team ID not configured (build without PIE_TEAM_ID)" };
  if (!c.teamId || c.teamId !== c.expectedTeamId) {
    return { ok: false, reason: `TeamIdentifier mismatch (got ${c.teamId ?? "unsigned"}, want ${c.expectedTeamId})` };
  }
  return { ok: true };
}

/** 顶栏 bundle 安装路径。硬编码，RPC 入参不得覆盖（否则 apply_update 成任意路径写原语）。单测经 UpdateDeps.appPath 注入。 */
export const PIE_LINK_APP_PATH = "/Applications/Pie Link.app";

export interface UpdateDeps {
  fetchJson: (url: string) => Promise<unknown>;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  codesignVerify: (binPath: string) => boolean;
  /** bundle 用 `codesign --verify --deep --strict`（#419）。 */
  codesignVerifyDeep: (bundlePath: string) => boolean;
  codesignInfo: (binPath: string) => string;
  unzipToBinary: (zipPath: string, destDir: string) => string;
  /** 解出顶层 `.app` 目录，不 walk 进 Contents/MacOS。 */
  unzipToBundle: (zipPath: string, destDir: string) => string;
  platform: NodeJS.Platform;
  binDir: string;
  /** 生产 = PIE_LINK_APP_PATH；仅单测注入。永不从 RPC 读取。 */
  appPath: string;
  expectedTeamId: string;
}

export function defaultFetchJson(url: string): Promise<unknown> {
  return fetch(url, { redirect: "follow" }).then((r) => {
    if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
    return r.json();
  });
}

export function defaultFetchBytes(url: string): Promise<Uint8Array> {
  return fetch(url, { redirect: "follow" }).then(async (r) => {
    if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  });
}
