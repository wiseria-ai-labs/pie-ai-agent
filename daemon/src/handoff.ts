import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { HandoffParams, HandoffResult } from "../../src/types/local-bridge";
import type { SpawnFn } from "./spawn";
import { realSpawn } from "./spawn";
import type { DetectedAgent } from "./agents";
import { detectAgents } from "./agents";
import { paths } from "./paths";
import { log } from "./log";
import { launchDarwinHandoff } from "./handoff-darwin";
import { launchWin32Handoff, windowsOpenDeeplink } from "./handoff-win32";

/** 我们在 handoff 目录里写死的文件名——用户传的文件不许撞它们。 */
const RESERVED = new Set(["context.md", "start.command", "start.bat", "claude.md", "agents.md"]);

/** 交棒引导语：terminal 注入 argv；深链预填 composer；无深链 / 回落写进 convention 文件。 */
export const HANDOFF_PROMPT =
  "Read context.md in this directory for the handed-off context, then continue the task.";

/** 深链模板：`{prompt}` / `{dir}` 占位，插入前 URL-encode。 */
export function buildDeeplinkUrl(template: string, prompt: string, dir: string): string {
  return template
    .replaceAll("{prompt}", encodeURIComponent(prompt))
    .replaceAll("{dir}", encodeURIComponent(dir));
}

/** slug：context 前 24 字符小写、非字母数字转 -。 */
function slugify(context: string): string {
  return (
    context.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "handoff"
  );
}

/**
 * 用户（被 untrusted 页面驱动的 LLM）传来的文件名一律取 basename：剥掉任何目录
 * 成分（`../` 遍历被中和成落在 handoff 目录内的裸名），并挡掉空名 / . / .. / 保留名。
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // 大小写不敏感比对：默认文件系统（APFS / NTFS 常见配置）大小写不敏感——
  // `START.COMMAND` / `Context.MD` 这类变体若只做大小写敏感比对会放过检查，却
  // 在磁盘上解析成同一份保留文件。
  if (!base || base === "." || base === ".." || RESERVED.has(base.toLowerCase())) {
    throw new Error(`unsafe file name: ${JSON.stringify(name)}`);
  }
  return base;
}

export async function runHandoff(
  params: HandoffParams,
  opts?: {
    spawn?: SpawnFn;
    ensureDir?: (dir: string) => void;
    writeFile?: (path: string, content: string, mode?: number) => void;
    now?: () => string;
    detect?: () => DetectedAgent[];
    platform?: NodeJS.Platform;
    which?: (bin: string) => string | null;
    exists?: (path: string) => boolean;
  },
): Promise<HandoffResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const writeFile =
    opts?.writeFile ?? ((p, c, m) => writeFileSync(p, c, m != null ? { mode: m } : undefined));
  const now = opts?.now ?? (() => new Date().toISOString().slice(0, 10));
  const detect = opts?.detect ?? detectAgents;
  const platform = opts?.platform ?? process.platform;

  // params 是 JSON 解析自 socket 的运行时值（daemon.ts 里只是 `as HandoffParams`
  // 断言，编译期类型在运行时不提供任何保证）。target 决定 spawn 什么：闸 =
  // 「∈ 本次现检测到的 id 集」——launch 命令/app 名全部来自静态候选表，wire 上
  // 的 target 只用来查表，未通过检测的 id（包括注入串）在任何写盘/spawn 之前
  // 被拒。旧 wire 值 "claude"（Slice 1 扩展）alias 到 claude-terminal。
  const requestedId = params.target === "claude" ? "claude-terminal" : params.target;
  const agent = detect().find((a) => a.id === requestedId);
  if (!agent) {
    throw new Error(`unsupported handoff target: ${JSON.stringify(params.target)}`);
  }

  const dir = join(paths.handoffsDir, `${now()}-${slugify(params.context)}`);
  ensureDir(dir);
  writeFile(join(dir, "context.md"), params.context);
  for (const f of params.files ?? []) {
    writeFile(join(dir, safeFileName(f.name)), f.content);
  }

  if (agent.kind === "app") {
    // 统一深链（Claude / Codex）：一次带目录 + 预填。成功则不写约定文件。
    if (agent.deeplink && !agent.deeplink.afterOpen) {
      const url = buildDeeplinkUrl(agent.deeplink.template, HANDOFF_PROMPT, dir);
      log("info", "handoff.open_app", {
        dir, target: agent.id, launch: "deeplink", files: (params.files ?? []).length,
      });
      const launch = platform === "win32" ? windowsOpenDeeplink(url) : { cmd: "open", args: [url] };
      const r = await spawn(launch.cmd, launch.args, dir);
      if (r.exitCode === 0) {
        return { dir, mode: "app", appLaunch: "deeplink" };
      }
      log("warn", "handoff.deeplink_fallback", {
        dir,
        target: agent.id,
        exitCode: r.exitCode,
        stderr: (r.stderr ?? "").trim().slice(0, 300),
      });
    }
    writeFile(join(dir, agent.convention ?? "AGENTS.md"), `${HANDOFF_PROMPT}\n`);
    log("info", "handoff.open_app", {
      dir, target: agent.id, launch: "open-a", files: (params.files ?? []).length,
    });
  } else {
    log("info", "handoff.open", { dir, target: agent.id, files: (params.files ?? []).length });
  }

  const argv = (agent.argv ?? ["{prompt}"]).map((a) => a.replace("{prompt}", HANDOFF_PROMPT));
  const io = { spawn, writeFile, which: opts?.which, exists: opts?.exists };
  if (platform === "win32") {
    await launchWin32Handoff(agent, dir, argv, io);
  } else {
    await launchDarwinHandoff(agent, dir, argv, io);
  }

  // Cursor：官方 prompt 深链没有 folder，先打开目录再发预填。
  if (agent.kind === "app" && agent.deeplink?.afterOpen) {
    const url = buildDeeplinkUrl(agent.deeplink.template, HANDOFF_PROMPT, dir);
    log("info", "handoff.open_app", {
      dir, target: agent.id, launch: "deeplink", files: (params.files ?? []).length,
    });
    const launch = platform === "win32" ? windowsOpenDeeplink(url) : { cmd: "open", args: [url] };
    const r = await spawn(launch.cmd, launch.args, dir);
    if (r.exitCode === 0) {
      return { dir, mode: "app", appLaunch: "deeplink" };
    }
    log("warn", "handoff.deeplink_fallback", {
      dir,
      target: agent.id,
      exitCode: r.exitCode,
      stderr: (r.stderr ?? "").trim().slice(0, 300),
    });
  }

  // `dir` 仍回填（加法，旧客户端可读）。新接口不得当合同（ADR 0012）。
  return { dir, mode: agent.kind, ...(agent.kind === "app" ? { appLaunch: "open-a" as const } : {}) };
}
