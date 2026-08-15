// Canonical L3 reference skill. Seeded to ~/.pie/skills/video-parser/ once.
// Authoring contract: CLI process, stdout + cwd files, no return value.

const SKILL_MD = `---
name: video-parser
description: Locally download a public video URL with yt-dlp, extract evenly spaced JPEG frames and audio with ffmpeg, optionally transcribe with whisper. Use when the page has no captions and the user still needs what was said, or when they ask to parse/download the video on their machine via Pie Link. Requires yt-dlp and ffmpeg on PATH.
---

# Video Parser (L3)

You are a **local** media pipeline. The browser already tried (or should try)
the page's own transcript first (\`video_transcript\` skill) and may have
captured frames with \`capture_video_frame\`. Only run this script when those
are not enough.

## Run

\`\`\`
run_skill_script({
  skillId: "video-parser",
  entry: "parse.ts",
  args: ["<https URL>", "--frames", "8"]
})
\`\`\`

- First positional arg = the video page URL (http/https only).
- Optional \`--frames N\` (default 8, max 12).
- The first run in a session pauses for the user to approve.

## After it finishes

Stdout is a short manifest. Files land in the session workspace:

- \`frames/frame_001.jpg\` … — feed each to \`read_skill_output({ path })\`
  (image paths come back as pictures).
- \`transcript.txt\` — only if a local \`whisper\` / \`whisper-cpp\` binary exists.
- \`audio.wav\` — extracted audio, even when whisper is missing.

If stdout says yt-dlp or ffmpeg are missing, **relay the install prompt**
(Settings → Local tools) and stop.

If stdout contains \`DOWNLOAD_BLOCKED\`, the site refused the download
(YouTube 403 / JS challenge). **Do not retry the same URL in a loop.**
Fall back to L1 captions and L1.5 \`capture_video_frame\` on the open tab.
Tell the user the local download was blocked — never invent a transcript.

Logged-in / DRM / cookie-gated videos are out of scope. Never ask the user
to export cookies.
`;

const PARSE_TS = `#!/usr/bin/env bun
// L3 video-parser — CLI. Print a manifest to stdout; write products to cwd.
// argv: <url> [--frames N]
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

// yt-dlp_macos is PyInstaller: it unpacks to $TMPDIR. The Pie sandbox only
// allows writes in cwd (session workspace), so point temp at ./.tmp.
const tmpDir = join(process.env.PIE_WORKSPACE || process.cwd(), ".tmp");
mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;
process.env.TEMP = tmpDir;
process.env.TMP = tmpDir;

const INSTALL =
  "NEED_HELPERS: yt-dlp,ffmpeg\\n" +
  "Pie can install these into ~/.pie/bin (Settings → Local integration → Local tools,\\n" +
  "or allow the install prompt on the confirmation card). No Homebrew or admin password.\\n" +
  "Transcription uses Pie official compute when available — do not install Whisper yourself." +
  "\\nManual fallback: brew install yt-dlp ffmpeg   |   winget install yt-dlp.yt-dlp Gyan.FFmpeg";

function which(cmd: string): string | null {
  const isWin = process.platform === "win32";
  const r = isWin
    ? Bun.spawnSync(["where.exe", cmd], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    : Bun.spawnSync(["sh", "-lc", \`command -v \${JSON.stringify(cmd)}\`], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  const p = r.stdout.toString().trim().split(/\\r?\\n/)[0] ?? "";
  return p.length > 0 ? p : null;
}

function run(argv: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir },
  });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function classifyYtdlpError(text: string): "tmpdir" | "blocked" | "private" | "other" {
  if (/Could not create temporary directory/i.test(text) || /\\[PYI-/.test(text)) return "tmpdir";
  const t = text.toLowerCase();
  if (/sign in|private video|members.only|login required|join this channel/.test(t)) return "private";
  if (/403|forbidden|nsig|js runtime|player_client|unable to download video data|http error 429|confirm you.re not a bot/.test(t)) {
    return "blocked";
  }
  return "other";
}

function detectJsRuntime(): { name: string; path: string } | null {
  for (const name of ["deno", "node", "bun"] as const) {
    const p = which(name);
    if (p) return { name, path: p };
  }
  return null;
}

function ytdlpBase(ytdlp: string, js: { name: string; path: string } | null): string[] {
  const a = [
    ytdlp,
    "--no-playlist",
    "--retries", "8",
    "--fragment-retries", "8",
    "--retry-sleep", "exp=1:8",
    "--socket-timeout", "20",
    "--newline",
    "--no-mtime",
  ];
  if (js) a.push("--js-runtimes", \`\${js.name}:\${js.path}\`);
  return a;
}

type Attempt = { label: string; extra: string[]; format: string };

function downloadAttempts(kind: "audio" | "video"): Attempt[] {
  const clients = [
    { label: "web+ios", extra: ["--extractor-args", "youtube:player_client=web,ios"] },
    { label: "tv", extra: ["--extractor-args", "youtube:player_client=tv,web"] },
    { label: "android", extra: ["--extractor-args", "youtube:player_client=android,web"] },
    { label: "default", extra: [] as string[] },
  ];
  const formats =
    kind === "audio"
      ? ["ba[ext=m4a]/ba/bestaudio", "bestaudio/best"]
      : ["18/bv*[height<=360][ext=mp4]/w", "bv*[height<=480]+ba/b[height<=480]/b"];
  const out: Attempt[] = [];
  for (const c of clients) for (const format of formats) out.push({ label: \`\${c.label}/\${format}\`, extra: c.extra, format });
  return out;
}

function firstExisting(prefix: string): string | undefined {
  return readdirSync(".").find((f) => f === prefix || f.startsWith(prefix + "."));
}

function tryDownload(
  kind: "audio" | "video",
  dest: string,
  base: string[],
): { ok: boolean; file?: string; log: string } {
  const logs: string[] = [];
  for (const attempt of downloadAttempts(kind)) {
    for (const leftover of readdirSync(".").filter((f) => f === dest || f.startsWith(dest + "."))) {
      try { unlinkSync(leftover); } catch { /* ignore */ }
    }
    console.log(\`trying \${kind} via \${attempt.label}\`);
    const r = run([...base, ...attempt.extra, "-f", attempt.format, "-o", dest + ".%(ext)s", url]);
    const file = firstExisting(dest);
    if (r.ok && file) return { ok: true, file, log: logs.join("\\n") };
    const tail = (r.stderr || r.stdout).trim().split("\\n").slice(-4).join(" | ");
    if (/semctl|sync semaphore|PYI-\\d+:ERROR/.test(r.stderr + r.stdout)) {
      console.error(
        "HELPER_BROKEN: this yt-dlp is a PyInstaller binary and cannot run inside Pie's sandbox (semctl denied). " +
          "Open Settings → Local integration → Local tools and reinstall yt-dlp (Pie will fetch the Python zipimport build).",
      );
      process.exit(1);
    }
    logs.push(\`\${attempt.label}: \${tail}\`);
  }
  return { ok: false, log: logs.join("\\n") };
}

function parseArgs(argv: string[]): { url: string; frames: number } {
  const rest = argv.slice(2);
  let frames = 8;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--frames" && rest[i + 1]) {
      const n = Number(rest[++i]);
      if (Number.isFinite(n)) frames = Math.max(1, Math.min(12, Math.floor(n)));
    } else if (rest[i] && !rest[i]!.startsWith("-")) {
      positional.push(rest[i]!);
    }
  }
  return { url: positional[0] ?? "", frames };
}

function assertHttpUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    console.error("First argument must be an http(s) video URL.");
    process.exit(2);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    console.error("Only http(s) URLs are allowed.");
    process.exit(2);
  }
}

const { url, frames } = parseArgs(process.argv);
if (!url) {
  console.error("Usage: parse.ts <https-url> [--frames 8]");
  process.exit(2);
}
assertHttpUrl(url);

const ytdlp = which("yt-dlp");
const ffmpeg = which("ffmpeg");
if (!ytdlp || !ffmpeg) {
  console.log(INSTALL);
  process.exit(1);
}

const whisper = which("whisper") ?? which("whisper-cpp") ?? which("whisper-cli");
const js = detectJsRuntime();

console.log(\`video-parser: fetching \${url}\`);
console.log(\`tools: yt-dlp=\${ytdlp} ffmpeg=\${ffmpeg} whisper=\${whisper ?? "(none)"} js=\${js ? js.name + "@" + js.path : "(none)"}\`);

const base = ytdlpBase(ytdlp, js);
const audioDl = tryDownload("audio", "audio.src", base);
const videoDl = tryDownload("video", "video.src", base);

if (!audioDl.ok && !videoDl.ok) {
  const combined = audioDl.log + "\\n" + videoDl.log;
  const kind = classifyYtdlpError(combined);
  console.error(combined.slice(-2500));
  if (kind === "tmpdir") {
    console.error("DOWNLOAD_FAILED: yt-dlp could not create a temporary directory (sandbox TMPDIR).");
  } else if (kind === "private") {
    console.error("DOWNLOAD_PRIVATE: this video needs a login or is private. Cookies are out of scope. Use L1/L1.5 on the open tab.");
  } else if (kind === "blocked") {
    console.error(
      "DOWNLOAD_BLOCKED: the site refused the download (often YouTube 403 / JS challenge)." +
        (js ? "" : " No JS runtime (deno/node/bun) was found — YouTube usually needs one.") +
        " Do not retry this URL. Fall back to L1 captions and L1.5 capture_video_frame.",
    );
  } else {
    console.error("DOWNLOAD_FAILED: yt-dlp could not fetch audio or video. Fall back to L1/L1.5.");
  }
  process.exit(1);
}

// Prefer a real video file for frames; otherwise derive both from whichever we got.
const source = videoDl.file ?? audioDl.file;
if (!source) {
  console.error("DOWNLOAD_FAILED: no media file on disk after yt-dlp.");
  process.exit(1);
}
if (!videoDl.ok) console.log("(video download blocked — frames may be missing; audio-only)");
if (!audioDl.ok) console.log("(audio download blocked — will try to pull audio from the video file)");

const probe = run([
  ffmpeg,
  "-i",
  source,
  "-hide_banner",
]);
const durMatch = (probe.stderr + probe.stdout).match(/Duration:\\s*(\\d+):(\\d+):(\\d+(?:\\.\\d+)?)/);
let duration = 0;
if (durMatch) {
  duration = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
}

mkdirSync("frames", { recursive: true });
if (videoDl.file) {
  const interval = duration > 0 ? Math.max(duration / (frames + 1), 0.5) : 5;
  const vf = duration > 0
    ? \`fps=1/\${interval.toFixed(3)}\`
    : "fps=1/5";
  const grab = run([
    ffmpeg,
    "-y",
    "-i",
    videoDl.file,
    "-vf",
    \`\${vf},scale='min(1280,iw)':-2\`,
    "-q:v",
    "3",
    "-frames:v",
    String(frames),
    join("frames", "frame_%03d.jpg"),
  ]);
  if (!grab.ok) {
    console.log("(ffmpeg frame extract failed; audio may still be available)");
    console.log(grab.stderr.slice(-800));
  }
} else {
  console.log("(no video stream — skip frames; use L1.5 capture_video_frame on the open tab)");
}

const audioIn = audioDl.file ?? source;
const audio = run([
  ffmpeg,
  "-y",
  "-i",
  audioIn,
  "-vn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-t",
  "600",
  "audio.wav",
]);
if (!audio.ok) {
  console.log("(audio extract failed; frames are still available)");
}

for (const leftover of [source, audioDl.file, videoDl.file]) {
  if (!leftover) continue;
  try { unlinkSync(leftover); } catch { /* keep if unlink fails */ }
}

let transcriptPath: string | null = null;
if (whisper && existsSync("audio.wav")) {
  const bin = whisper;
  const isOpenai = /whisper$/.test(bin) && !/whisper-cpp|whisper-cli/.test(bin);
  const tr = isOpenai
    ? run([bin, "audio.wav", "--model", "base", "--output_format", "txt", "--output_dir", "."])
    : run([bin, "-f", "audio.wav", "-otxt", "-of", "transcript"]);
  if (tr.ok) {
    const candidate = existsSync("audio.txt")
      ? "audio.txt"
      : existsSync("transcript.txt")
        ? "transcript.txt"
        : null;
    if (candidate && candidate !== "transcript.txt") {
      writeFileSync("transcript.txt", readFileSync(candidate, "utf8"));
    }
    if (existsSync("transcript.txt")) transcriptPath = "transcript.txt";
  } else {
    console.log("(whisper present but transcription failed; install guide above if you want it)");
  }
}

const frameFiles = readdirSync("frames")
  .filter((f) => f.endsWith(".jpg"))
  .sort();

console.log("VIDEO_PARSE");
console.log(\`url: \${url}\`);
console.log(\`duration_s: \${duration.toFixed(1)}\`);
console.log(\`frames: \${frameFiles.length}\`);
for (let i = 0; i < frameFiles.length; i++) {
  const t = duration > 0 ? ((i + 1) * duration) / (frameFiles.length + 1) : (i + 1) * 5;
  console.log(\`  frames/\${frameFiles[i]} @ \${t.toFixed(1)}s\`);
}
console.log(\`audio: \${existsSync("audio.wav") ? "audio.wav" : "(none)"}\`);
console.log(
  \`transcript: \${transcriptPath ?? "(none — official whisper compute or L1 page captions)"}\`,
);
console.log("Read frames with read_skill_output({ path: \\"frames/frame_001.jpg\\" }).");
`;

export const VIDEO_PARSER_FILES: Record<string, string> = {
  "SKILL.md": SKILL_MD,
  "scripts/parse.ts": PARSE_TS,
};
