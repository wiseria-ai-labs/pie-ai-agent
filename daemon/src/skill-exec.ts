import { mkdirSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { paths, sessionWorkspace } from "./paths";
import { log } from "./log";
import { assertSkillName, listSkills, resolveSkillRoot, defaultRoots } from "./skill-store";
import type { SkillRoots } from "./skill-store";
import { getCachedUserPath } from "./agents";
import { appendAudit } from "./audit";
import { beginSkillRun, endSkillRun } from "./status";
import { realSkillSandbox, checkWindowsSandboxReady } from "./skill-sandbox";
import type { SkillSandbox } from "./skill-sandbox";
import type { RunSkillScriptParams, RunSkillScriptResult, SandboxBaseline } from "../../src/types/local-bridge";

export interface SkillExecDeps {
  sandbox?: SkillSandbox;
  now?: () => number;
  /** 沙箱设施就绪探针（F6）：非 win32 恒 ready；win32 走 WFP egress 行为探针。测试可注入。 */
  readinessCheck?: () => Promise<{ ready: boolean; reason?: string }>;
  /** 单根别名（既有测试用）：等价 roots={primary: skillsRoot}，不带默认副根 */
  skillsRoot?: string;
  roots?: SkillRoots;
  /** session workspace 根覆盖（测试隔离真实 ~/.pie/sessions） */
  sessionsDir?: string;
  auditPath?: string;
  /** env 白名单构建注入（测试用）：缺省走 buildSandboxEnv（login-shell PATH + 白名单擦除）。 */
  buildEnv?: (extra: Record<string, string>) => Record<string, string>;
}

/**
 * env 白名单版本号（ADR 0007 / D7）。网络全放后 env 擦除是强制项，这个号码记进 audit，
 * 擦除口径变更（增删白名单键）时递增，事后审计能对上「那次是在什么擦除策略下跑的」。
 */
export const ENV_ALLOWLIST_VERSION = "1";

/** 原样透传的 env 键（spec D7）。PATH 单列（用 login-shell 解析版）；LC_* 前缀匹配另处理。 */
const ENV_PASSTHROUGH_KEYS = ["HOME", "TMPDIR", "LANG", "USER", "SHELL"] as const;

/**
 * 固定基线沙箱的 env 白名单擦除（D7）：网络全放后，子进程只拿受控的一小撮 env，
 * 其余（各类 token / api key / 云厂商凭据）全擦。PATH 用 daemon 的 login-shell
 * 解析版（launchd 裸 PATH 看不见 homebrew 的 yt-dlp/ffmpeg）。extra 是调用方注入的
 * PIE_ 前缀变量与 BUN_BE_BUN，最后覆盖（不被白名单里的同名键顶掉）。
 * opts 供单测注入 path/env，产品调用走 getCachedUserPath() + process.env
 * （热路径，login-shell PATH 探测在 daemon 生命周期内缓存一次）。
 */
export function buildSandboxEnv(
  extra: Record<string, string>,
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const src = opts.env ?? process.env;
  const out: Record<string, string> = {};
  const path = opts.path ?? getCachedUserPath();
  if (path) out.PATH = path;
  for (const k of ENV_PASSTHROUGH_KEYS) {
    const v = src[k];
    if (typeof v === "string") out[k] = v;
  }
  // LC_*（LC_ALL / LC_CTYPE / …）整族放行——本地化，无外泄价值。
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("LC_") && typeof v === "string") out[k] = v;
  }
  return { ...out, ...extra };
}

/** 本次产物清单上限：脚本可能生成上千分片，无上限会撑爆 observation。 */
const OUTPUTS_CAP = 50;

/** run 后递归扫 workspace，收 mtime >= startedAt 的文件（本次产物），path 相对 workspace 根。
 *  封顶 OUTPUTS_CAP，超出置 truncated。workspace 不存在（脚本没写任何文件）→ 空。 */
export function scanOutputs(
  workspace: string,
  startedAt: number,
): { outputs: { path: string; bytes: number }[]; truncated: boolean } {
  const outputs: { path: string; bytes: number }[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // workspace 不存在或不可读
    }
    for (const e of entries) {
      if (truncated) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.mtimeMs >= startedAt) {
          if (outputs.length >= OUTPUTS_CAP) {
            truncated = true;
            return;
          }
          outputs.push({ path: relative(workspace, abs), bytes: st.size });
        }
      }
    }
  };
  walk(workspace);
  return { outputs, truncated };
}

/** 敏感目录默认拒读（网络全放后的纵深防御：env 擦除挡环境凭据，这里挡直接读磁盘密钥）。 */
export function baselineDenyRead(): string[] {
  const h = homedir();
  return [
    join(h, ".ssh"),
    join(h, ".aws"),
    join(h, ".gnupg"),
    paths.logsDir,
  ];
}

/** 全局安装 Python 缺失时的引导文案（F4：per-user / Store 别名沙箱账户不可见）。 */
const PY_NOT_FOUND_MSG =
  '未找到全局安装的 Python（已排除 Microsoft Store 执行别名）。请从 python.org 安装 Python 时勾选 "Install for all users"（全局安装），沙箱账户才能访问它。';
/** Windows 不支持 .sh 的引导文案（建议作者提供跨平台 ts 版本）。 */
const SH_UNSUPPORTED_MSG =
  "Windows 上不支持执行 .sh 脚本；请让该 skill 的作者提供跨平台的 .ts 版本。";

/** F4：`where python` 常同时命中 `\WindowsApps\` 的 Store 执行别名 stub（per-user
 *  reparse point，沙箱账户必然拒访问）。排除这些后取第一个真实候选；无候选 = null
 *  （按"无全局 python"处理）。纯函数，供单测覆盖排除规则。 */
export function pickWindowsPython(candidates: string[]): string | null {
  const real = candidates
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/\\WindowsApps\\/i.test(c));
  return real[0] ?? null;
}

/** 宿主侧探测全局 python（非沙箱内，spawnSync 无害——那条铁律只针对沙箱子进程）。
 *  排除 WindowsApps stub 后返回绝对路径，探测不到返回 null。 */
function findWindowsPython(): string | null {
  try {
    const r = Bun.spawnSync(["where.exe", "python"]);
    if (r.exitCode !== 0) return null;
    return pickWindowsPython(r.stdout.toString().split(/\r?\n/));
  } catch {
    return null;
  }
}

/** 解释器 argv 前缀（spec §4.8）：
 *  - `.ts/.js/.mjs/.cjs` → 内嵌 Bun（`[execPath, "run"]`，需 `BUN_BE_BUN=1`），三平台一致；
 *  - `.py` → mac/linux 走 `python3`；Windows 探测全局 python（排除 Store 别名），无则 `no_python`；
 *  - `.sh` → mac/linux 走 `bash`；Windows 明确报 `unsupported_script`（建议 ts 版本）。
 *  opts 供测试注入 platform / findPython，产品调用走 process.platform + 真机探测。 */
export function interpreterFor(
  entry: string,
  opts: { platform?: NodeJS.Platform; findPython?: () => string | null } = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run"]; // 需 BUN_BE_BUN=1
  if (/\.py$/.test(entry)) {
    if (platform !== "win32") return ["python3"];
    const py = (opts.findPython ?? findWindowsPython)();
    if (!py) throw Object.assign(new Error(PY_NOT_FOUND_MSG), { code: "no_python" });
    return [py];
  }
  if (/\.sh$/.test(entry)) {
    if (platform === "win32") throw Object.assign(new Error(SH_UNSUPPORTED_MSG), { code: "unsupported_script" });
    return ["bash"];
  }
  return [process.execPath, "run"]; // 默认按 JS 跑
}

export async function runSkillScript(
  params: RunSkillScriptParams,
  deps: SkillExecDeps = {},
): Promise<RunSkillScriptResult> {
  const now = deps.now ?? Date.now;
  const roots: SkillRoots = deps.roots ?? (deps.skillsRoot ? { primary: deps.skillsRoot } : defaultRoots);
  const auditPath = deps.auditPath ?? paths.auditPath;
  const sessionsDir = deps.sessionsDir ?? paths.sessionsDir;
  const sandbox = deps.sandbox ?? realSkillSandbox;
  const readinessCheck = deps.readinessCheck ?? checkWindowsSandboxReady;
  const buildEnv = deps.buildEnv ?? ((extra: Record<string, string>) => buildSandboxEnv(extra));

  const name = assertSkillName(params.name);
  const located = resolveSkillRoot(name, roots);
  if (!located) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  const summary = listSkills(located.root).find((s) => s.name === name);
  if (!summary) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  if (!summary.runnableScripts.includes(params.entry)) {
    throw Object.assign(new Error(`entry not in scripts/: ${JSON.stringify(params.entry)}`), { code: "unknown_entry" });
  }

  // 解释器解析先行（spec §4.8）：.sh/win 或缺 python 的 skill 直接失败，不弹授权卡。
  // interpreterFor 在 Windows 上可能 throw（unsupported_script / no_python），随 code 透传。
  const interp = interpreterFor(params.entry);

  // 沙箱设施就绪检查（F6，fail-closed）：设施未就绪 → 明确报错引导重装，且先于授权卡与执行。
  // 非 win32 宿主上 checkWindowsSandboxReady 恒 ready，既有 mac 行为不变。
  const readiness = await readinessCheck();
  if (!readiness.ready) {
    throw Object.assign(
      new Error(`Windows 脚本沙箱未就绪${readiness.reason ? `：${readiness.reason}` : ""}。请重装 Pie Link 以修复沙箱设施。`),
      { code: "sandbox_not_ready" },
    );
  }

  // ADR 0007：daemon 不再做任何授权判定——能连 daemon.sock 的本地进程本就是用户权限
  // 进程，信封 hash / TOCTOU 重调防的是不存在的攻击者。唯一的信任边界「LLM 不能自批」
  // 由扩展 SW 层的确认卡保证；daemon 收到 run_skill_script 即按固定基线沙箱执行。

  const skillDir = join(located.root, name);
  // 产物区按 session 隔离，且搬出 skill 目录——脚本进程永不写入任何 skill 目录（主根或
  // 只读副根）。这里是「副根污染」bug（旧 mkdir skillDir/workspace）的修复点。
  const workspace = sessionWorkspace(params.sessionId, sessionsDir);
  mkdirSync(workspace, { recursive: true });

  // 固定基线沙箱（不可声明不可配，ADR 0007）：写限 workspace（skill 目录含只读副根永不
  // 可写），denyRead 基线挡磁盘密钥，网络全放（外泄面靠 env 擦除 + denyRead 压制）。
  const settings = {
    allowWrite: [workspace],
    denyRead: baselineDenyRead(),
  };
  const argv = [...interp, join(skillDir, "scripts", params.entry), ...(params.args ?? [])];
  // cwd = workspace（可写区），skillDir 通过 PIE_SKILL_DIR 供脚本读自身资源。
  // env 走白名单擦除（D7）：只有 PIE_*/BUN_BE_BUN + 一小撮受控系统 env + login-shell PATH。
  const env = buildEnv({ BUN_BE_BUN: "1", PIE_SKILL_DIR: skillDir, PIE_WORKSPACE: workspace });

  const startedAt = now();
  log("info", "skill.run", { name, entry: params.entry });
  // 活跃执行注册表：顶栏 app 的 status RPC 据此显示「正在运行的 skill」。
  const runId = beginSkillRun(name, params.entry);
  let res;
  try {
    res = await sandbox.run(argv, workspace, env, settings);
  } finally {
    endSkillRun(runId);
  }

  const sandboxBaseline: SandboxBaseline = { network: "open", envAllowlist: ENV_ALLOWLIST_VERSION };
  appendAudit(
    { ts: now(), skillName: name, entry: params.entry, exitCode: res.exitCode, timedOut: res.timedOut, truncated: res.truncated, ms: now() - startedAt, sandbox: sandboxBaseline },
    auditPath,
  );

  if (res.timedOut) throw Object.assign(new Error("skill script timed out"), { code: "timeout" });
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(`skill script exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`), { code: "script_error" });
  }
  // 本次产物 = workspace 里 mtime >= startedAt 的文件（daemon 扫盘得出运行时事实，
  // 不靠脚本自觉 print 清单）。
  const { outputs, truncated: outputsTruncated } = scanOutputs(workspace, startedAt);
  const result: RunSkillScriptResult = { output: res.stdout, truncated: res.truncated || undefined };
  if (outputs.length > 0) result.outputs = outputs;
  if (outputsTruncated) result.outputsTruncated = true;
  return result;
}
