// Pie-managed local helpers (yt-dlp / ffmpeg) live in ~/.pie/bin — same
// user-writable directory as the daemon binary. Users should not need brew,
// apt, or admin rights. Whisper is NOT installed here (official / BYOK compute).
import { existsSync, mkdirSync, writeFileSync, chmodSync, renameSync, rmSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { paths } from "./paths";
import { getCachedUserPath } from "./agents";
import type {
  EnsureSkillHelpersParams,
  ListSkillHelpersResult,
  SkillHelperId,
  SkillHelperStatus,
} from "../../src/types/local-bridge";

const ALL_IDS: SkillHelperId[] = ["yt-dlp", "ffmpeg"];

const YTDLP_RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const FFMPEG_EVERMEET = "https://evermeet.cx/ffmpeg/getrelease/zip";
const FFMPEG_BTBN_WIN =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const FFMPEG_BTBN_LINUX =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

export function helperFileName(id: SkillHelperId, platform: NodeJS.Platform): string {
  if (platform === "win32") return id === "ffmpeg" ? "ffmpeg.exe" : "yt-dlp.exe";
  return id;
}

export function isAllowedHelperUrl(url: string): boolean {
  return (
    url.startsWith(YTDLP_RELEASE) ||
    url.startsWith("https://evermeet.cx/ffmpeg/") ||
    url.startsWith("https://github.com/BtbN/FFmpeg-Builds/releases/")
  );
}

export function prependBinDir(pathEnv: string, binDir: string, platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? ";" : ":";
  if (!pathEnv) return binDir;
  const parts = pathEnv.split(sep).filter(Boolean);
  if (parts[0] === binDir) return pathEnv;
  return [binDir, ...parts.filter((p) => p !== binDir)].join(sep);
}

export interface HelperResolve {
  which?: (cmd: string, pathEnv: string) => string | null;
  binDir?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

function defaultWhich(cmd: string, pathEnv: string): string | null {
  const isWin = process.platform === "win32";
  const r = isWin
    ? Bun.spawnSync(["where.exe", cmd], { env: { ...process.env, PATH: pathEnv }, stdout: "pipe", stderr: "pipe" })
    : Bun.spawnSync(["sh", "-lc", `PATH=${JSON.stringify(pathEnv)} command -v ${JSON.stringify(cmd)}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
  if (r.exitCode !== 0) return null;
  const line = r.stdout.toString().trim().split(/\r?\n/)[0] ?? "";
  return line.length > 0 ? line : null;
}

export function resolveHelper(id: SkillHelperId, opts: HelperResolve = {}): SkillHelperStatus {
  const platform = opts.platform ?? process.platform;
  const binDir = opts.binDir ?? paths.binDir;
  const pathEnv = opts.pathEnv ?? getCachedUserPath();
  const which = opts.which ?? defaultWhich;
  const local = join(binDir, helperFileName(id, platform));
  if (existsSync(local)) return { id, present: true, path: local, source: "pie-bin" };
  const onPath = which(helperFileName(id, platform).replace(/\.exe$/i, ""), pathEnv);
  if (onPath) return { id, present: true, path: onPath, source: "path" };
  return { id, present: false };
}

export function listSkillHelpers(opts: HelperResolve = {}): ListSkillHelpersResult {
  return { helpers: ALL_IDS.map((id) => resolveHelper(id, opts)), installable: true };
}

export interface HelperInstallDeps extends HelperResolve {
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  extractTo?: (archive: string, destFile: string, id: SkillHelperId) => void;
  smoke?: (bin: string, id: SkillHelperId) => boolean | { ok: boolean; detail: string };
}

function ytdlpUrl(platform: NodeJS.Platform): string {
  if (platform === "win32") return `${YTDLP_RELEASE}yt-dlp.exe`;
  if (platform === "darwin") return `${YTDLP_RELEASE}yt-dlp_macos`;
  return `${YTDLP_RELEASE}yt-dlp_linux`;
}

function ffmpegUrl(platform: NodeJS.Platform): string {
  if (platform === "darwin") return FFMPEG_EVERMEET;
  if (platform === "win32") return FFMPEG_BTBN_WIN;
  return FFMPEG_BTBN_LINUX;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** yt-dlp --version is a date (`2026.07.04`); ffmpeg prints `ffmpeg version …`. */
export function helperVersionLooksRight(id: SkillHelperId, output: string): boolean {
  const out = output.trim();
  if (id === "ffmpeg") return out.toLowerCase().includes("ffmpeg");
  return /\d{4}\.\d{2}\.\d{2}/.test(out) || out.toLowerCase().includes("yt-dlp");
}

function defaultSmoke(bin: string, id: SkillHelperId): { ok: boolean; detail: string } {
  const flag = id === "ffmpeg" ? "-version" : "--version";
  try {
    const r = Bun.spawnSync([bin, flag], { stdout: "pipe", stderr: "pipe" });
    const out = (r.stdout.toString() + r.stderr.toString()).trim();
    if (r.exitCode !== 0) {
      return { ok: false, detail: `exit ${r.exitCode}${r.signalCode ? `/${r.signalCode}` : ""}: ${out.slice(0, 300)}` };
    }
    const looksRight = helperVersionLooksRight(id, out);
    return looksRight
      ? { ok: true, detail: out.split("\n")[0] ?? "" }
      : { ok: false, detail: `unexpected ${id} output: ${out.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function defaultExtract(archive: string, destFile: string, id: SkillHelperId): void {
  if (id !== "ffmpeg") {
    // yt-dlp is a single file already written to destFile.
    return;
  }
  const work = join(tmpdir(), `pie-helper-x-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    if (archive.endsWith(".tar.xz") || archive.endsWith(".txz")) {
      const r = Bun.spawnSync(["tar", "-xJf", archive, "-C", work], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString() || "tar extract failed");
    } else {
      const r = Bun.spawnSync(["unzip", "-o", archive, "-d", work], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString() || "unzip failed");
    }
    const found = findExtracted(work, /^ffmpeg(\.exe)?$/i);
    if (!found) throw new Error("archive did not contain an ffmpeg binary");
    writeFileSync(destFile, readFileSync(found));
    chmodSync(destFile, 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function findExtracted(dir: string, re: RegExp): string | null {
  const walk = (d: string): string | null => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const hit = walk(abs);
        if (hit) return hit;
      } else if (re.test(name)) {
        return abs;
      }
    }
    return null;
  };
  return walk(dir);
}

async function installOne(id: SkillHelperId, deps: HelperInstallDeps): Promise<SkillHelperStatus> {
  const platform = deps.platform ?? process.platform;
  const binDir = deps.binDir ?? paths.binDir;
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, helperFileName(id, platform));
  const url = id === "yt-dlp" ? ytdlpUrl(platform) : ffmpegUrl(platform);
  if (!isAllowedHelperUrl(url)) throw new Error(`helper url not allowlisted: ${url}`);
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const bytes = await fetchBytes(url);
  const staged = `${dest}.new`;
  writeFileSync(staged, bytes);
  if (id === "ffmpeg") {
    const extract = deps.extractTo ?? defaultExtract;
    const archive = url.endsWith(".tar.xz") ? `${staged}.tar.xz` : `${staged}.zip`;
    renameSync(staged, archive);
    extract(archive, dest, id);
    rmSync(archive, { force: true });
  } else {
    chmodSync(staged, 0o755);
    renameSync(staged, dest);
  }
  chmodSync(dest, 0o755);
  // curl/Safari quarantine makes a freshly written Mach-O look like EACCES.
  try {
    Bun.spawnSync(["xattr", "-c", dest], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* non-mac / no xattr */
  }
  const smoke = deps.smoke ?? defaultSmoke;
  const verdict = smoke(dest, id);
  const failed = typeof verdict === "boolean" ? !verdict : !verdict.ok;
  if (failed) {
    const detail = typeof verdict === "boolean" ? "" : verdict.detail;
    rmSync(dest, { force: true });
    throw new Error(`${id} downloaded but failed a version check${detail ? `: ${detail}` : ""}`);
  }
  return { id, present: true, path: dest, source: "pie-bin" };
}

export async function ensureSkillHelpers(
  params: EnsureSkillHelpersParams = {},
  deps: HelperInstallDeps = {},
): Promise<{ helpers: SkillHelperStatus[] }> {
  const wanted = params.ids && params.ids.length > 0 ? params.ids : ALL_IDS;
  const out: SkillHelperStatus[] = [];
  for (const id of wanted) {
    const have = resolveHelper(id, deps);
    if (have.present) {
      out.push(have);
      continue;
    }
    out.push(await installOne(id, deps));
  }
  return { helpers: out };
}
