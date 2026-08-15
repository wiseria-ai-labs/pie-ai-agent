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

If stdout says yt-dlp or ffmpeg is missing, **relay the install guide** and
stop. Do not invent a transcript.

Logged-in / DRM / cookie-gated videos are out of scope. Never ask the user
to export cookies.
`;

const PARSE_TS = `#!/usr/bin/env bun
// L3 video-parser — CLI. Print a manifest to stdout; write products to cwd.
// argv: <url> [--frames N]
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const INSTALL =
  "Missing tools. Install both, then retry:\\n" +
  "  macOS:   brew install yt-dlp ffmpeg\\n" +
  "  Ubuntu:  sudo apt install yt-dlp ffmpeg\\n" +
  "  Windows: winget install yt-dlp.yt-dlp Gyan.FFmpeg\\n" +
  "Optional transcription: pipx install openai-whisper   # or brew install whisper-cpp";

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
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
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

console.log(\`video-parser: fetching \${url}\`);
console.log(\`tools: yt-dlp=\${ytdlp} ffmpeg=\${ffmpeg} whisper=\${whisper ?? "(none)"}\`);

const dl = run([
  ytdlp,
  "--no-playlist",
  "--no-warnings",
  "-f",
  "bv*[height<=480]+ba/b[height<=480]/b",
  "--max-filesize",
  "80M",
  "-o",
  "source.%(ext)s",
  url,
]);
if (!dl.ok) {
  console.error(dl.stderr.slice(-2000) || dl.stdout.slice(-2000));
  console.error("yt-dlp failed. The video may be private, geo-blocked, or DRM-protected.");
  process.exit(1);
}

const source = readdirSync(".").find((f) => f.startsWith("source."));
if (!source) {
  console.error("yt-dlp reported success but wrote no source.* file.");
  process.exit(1);
}

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
const interval = duration > 0 ? Math.max(duration / (frames + 1), 0.5) : 5;
const vf = duration > 0
  ? \`fps=1/\${interval.toFixed(3)}\`
  : "fps=1/5";
const grab = run([
  ffmpeg,
  "-y",
  "-i",
  source,
  "-vf",
  \`\${vf},scale='min(1280,iw)':-2\`,
  "-q:v",
  "3",
  "-frames:v",
  String(frames),
  join("frames", "frame_%03d.jpg"),
]);
if (!grab.ok) {
  console.error(grab.stderr.slice(-1500));
  console.error("ffmpeg frame extract failed.");
  process.exit(1);
}

const audio = run([
  ffmpeg,
  "-y",
  "-i",
  source,
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

try {
  unlinkSync(source);
} catch {
  /* keep source if unlink fails */
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
  \`transcript: \${transcriptPath ?? "(none — install openai-whisper or use the page transcript / L1)"}\`,
);
console.log("Read frames with read_skill_output({ path: \\"frames/frame_001.jpg\\" }).");
`;

export const VIDEO_PARSER_FILES: Record<string, string> = {
  "SKILL.md": SKILL_MD,
  "scripts/parse.ts": PARSE_TS,
};
