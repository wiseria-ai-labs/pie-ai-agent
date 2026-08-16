// Pie 自有 SkillSandbox 接口 + srt 后端。把 @anthropic-ai/sandbox-runtime（研究预览，
// API 可能演进）挡在这一层后：上层 skill-exec 只依赖 SkillSandbox，换后端不动编排。
//
// Spike 结论（docs/plans/2026-07-10-skill-daemon-fs-foundation.spike.md）：
//   - srt 的 SandboxManager 在 bun runtime + `bun build --compile` 二进制里全部工作：
//     文件写限 / 敏感读拒 / 默认断网 / 按域名放行网络，端到端真机验证过。
//   - 硬约束：跑沙箱子进程必须用异步 Bun.spawn，绝不能 Bun.spawnSync——srt 的网络
//     放行靠一个进程内 JS 代理，spawnSync 会阻塞 bun 单线程事件循环 → 代理不转发 →
//     所有出站挂到超时（这个坑在 spike 里踩过，务必别复现）。
//   - SandboxManager 是全局单例（initialize/updateConfig/reset 改共享状态 + 起代理端口），
//     故 run() 全程串行化：一次只跑一个沙箱，避免并发请求互相踩配置/代理。
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { runtimeFeatures } from "./runtime-features";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface SandboxSettings {
  /** 绝对路径白名单，只有这些子树可写（固定基线 = session workspace） */
  allowWrite: string[];
  /** 拒读的绝对路径（敏感目录） */
  denyRead: string[];
}
export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}
export interface SandboxRunOpts {
  signal?: AbortSignal;
  onStart?: () => void;
  onStdout?: (chunk: string) => void;
}

export interface SkillSandbox {
  /** 在 settings 约束下跑 argv（argv[0] 是解释器绝对路径）。cwd/env 由调用方给。
   *  无超时：终止权 = signal abort + 断连收尸。 */
  run(
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    settings: SandboxSettings,
    opts?: SandboxRunOpts,
  ): Promise<SandboxRunResult>;
}

/** 测试注入：直接把 impl 当 run，不碰真 srt/OS。 */
export function fakeSkillSandbox(impl: SkillSandbox["run"]): SkillSandbox {
  return { run: impl };
}

/**
 * spawn env 合成（D7 env 白名单擦除的核心判定，抽成纯函数供单测——spawn 层不被
 * `fakeSkillSandbox` 短路）：
 *  - mac/linux：**只用** caller 白名单 `env`。srt 0.0.67 的 `wrapped.env` 是全量
 *    process.env（不是代理注入的少量变量），出站代理 env 已内联进 wrapped 命令串，故
 *    绝不展开 `wrapped.env`，否则各类 *_TOKEN/AWS_* 凭据在网络全放下随子进程外泄。
 *  - win32：process.env + `wrapped.env`（broker 进程需 srt-win 自己的代理/CA 配置；沙箱
 *    子进程的 env 另经 cmd 内联 `set` 链，不从 spawn env 继承）。
 */
export function buildSpawnEnv(
  isWin: boolean,
  whitelistEnv: Record<string, string>,
  procEnv: Record<string, string | undefined>,
  wrappedEnv: Record<string, string>,
): Record<string, string | undefined> {
  return isWin ? { ...procEnv, ...wrappedEnv } : whitelistEnv;
}

/** POSIX 单引号包每个 arg：'\'' 转义单引号。argv → 可交给 srt 的 shell 命令串。 */
function shellQuote(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

// 全局串行化：SandboxManager 是单例，一次只允许一个沙箱运行。
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function drainCapped(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (text: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  // 增量读 + 封顶 MAX_OUTPUT_BYTES：读满即停拼接，但继续排空管道（防子进程写阻塞死锁，
  // 同 2b realSkillSpawn 的教训——stdout/stderr 必须都排空）。
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = dec.decode(value, { stream: true });
    onChunk?.(piece);
    if (text.length <= MAX_OUTPUT_BYTES) {
      text += piece;
      if (text.length > MAX_OUTPUT_BYTES) {
        text = text.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
      }
    }
    // 已封顶：继续读走剩余 chunk，只是不再拼接。
  }
  return { text, truncated };
}

async function runViaSrt(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  settings: SandboxSettings,
  opts?: SandboxRunOpts,
): Promise<SandboxRunResult> {
  const runtimeConfig = {
    // 固定基线：网络全放（ADR 0007）。srt 的 allowedDomains 不接受 "*"（schema 只在
    // deniedDomains 认通配），故走「无显式规则 → ask 回调」这条路：allowedDomains/
    // deniedDomains 都留空，任何 host 落到下面注册的 alwaysAllow 回调 → 放行。外泄面
    // 靠 env 白名单擦除 + denyRead 基线压制，不靠域名白名单。
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: settings.denyRead,
      allowRead: [],
      allowWrite: settings.allowWrite,
      denyWrite: [],
    },
  };
  // ask 回调恒 true = 网络全放（任何未显式命中规则的 host 都放行）。
  await SandboxManager.initialize(runtimeConfig, async () => true);
  try {
    await SandboxManager.waitForNetworkInitialization();
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      shellQuote(argv),
      undefined,
      undefined,
      undefined,
      cwd,
    );
    // 异步 spawn（关键：绝不 spawnSync，见文件头注释）。
    // env 白名单擦除（D7）：mac/linux 子进程只拿 caller 给的白名单 env（PIE_*/PATH/
    // HOME/… 已由 skill-exec 的 buildSandboxEnv 收窄）——绝不整体透传 process.env，否则
    // 各类 *_TOKEN/AWS_* 凭据在网络全放下会随子进程外泄。
    //   ⚠️ 关键坑（PR #19 真机验收 FAIL）：srt 0.0.67 的 `wrapWithSandboxArgv` 在
    //   mac/linux 分支返回的 `wrapped.env` **就是全量 process.env**（见 sandbox-manager.js
    //   `return { argv: [shell, '-c', wrapped], env: process.env }`）——它不是「代理注入的
    //   少量变量」。出站代理 env（HTTP_PROXY / NODE_EXTRA_CA_CERTS…）由 srt **内联进
    //   wrapped 命令串**（macos-sandbox-utils.js `env <proxyEnvArgs> sandbox-exec …`），
    //   不依赖 spawn env。所以 mac/linux **绝不能**再展开 `wrapped.env`，否则白名单被整个
    //   process.env 覆盖回去、擦除失效。只传白名单 `env`。
    // win32 走另一条路：子进程 env 已内联进 cmd 命令串（不穿透 CreateProcessWithLogonW
    // 换的沙箱账户，见 F3），broker 进程本身仍需 process.env + wrapped.env（srt-win 自己的
    // 代理/CA 配置）来把请求路由到围栏，故 win32 分支保留 `wrapped.env` 展开。
    if (opts?.signal?.aborted) {
      return { stdout: "", stderr: "killed", exitCode: 137, timedOut: false, truncated: false };
    }
    opts?.onStart?.();
    const proc = Bun.spawn({
      cmd: wrapped.argv,
      cwd,
      env: buildSpawnEnv(false, env, process.env, wrapped.env as Record<string, string>),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    };
    opts?.signal?.addEventListener("abort", onAbort);
    try {
      const [out, err, exitCode] = await Promise.all([
        drainCapped(proc.stdout, opts?.onStdout),
        drainCapped(proc.stderr),
        proc.exited,
      ]);
      // F2：win32 上 Bun 会把 NTSTATUS 退出码截断为低 8 位（如 0xC0000135→53）。
      // 原样透传，不做武断分类——诊断时用低 8 位反推 NTSTATUS。
      return {
        stdout: out.text,
        stderr: err.text,
        exitCode,
        timedOut: false,
        truncated: out.truncated,
      };
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  }
}

export const realSkillSandbox: SkillSandbox = {
  run: (argv, cwd, env, settings, opts) => serialize(() => runViaSrt(argv, cwd, env, settings, opts)),
};

/**
 * Windows passthrough 后端（产品决策 2026-08-13）：**放弃 srt-win，Windows 上 skill 脚本
 * 不进沙箱**，以用户账户权限直接执行——可读写用户文件、访问网络。原因：srt-win Windows
 * 后端 alpha 且踩了不可用的坑（W-4 沙箱账户读不到 profile 下脚本 EPERM；W-6 每次调用 ~30s
 * WFP verify 单线程阻塞；上游 #402 写围栏本就可绕过）。与其交付一个有洞、还极慢的假沙箱，
 * 不如**显式风险披露 + 用户知情同意**（grant 卡承载，payload.unsandboxed 标记）——功能可用
 * 且诚实。settings 在此仅作 grant 记录，不做任何强制。
 *
 * 仍走 **async Bun.spawn**（绝不 spawnSync）；env 直接注入（无 srt 账户切换，无 F3 穿透问题）；
 * 无超时 + drainCapped 封顶，与 srt 后端对齐。终止权 = signal abort。
 */
async function runPassthrough(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  _settings?: SandboxSettings,
  opts?: SandboxRunOpts,
): Promise<SandboxRunResult> {
  if (opts?.signal?.aborted) {
    return { stdout: "", stderr: "killed", exitCode: 137, timedOut: false, truncated: false };
  }
  opts?.onStart?.();
  const proc = Bun.spawn({
    cmd: argv,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  };
  opts?.signal?.addEventListener("abort", onAbort);
  try {
    const [out, err, exitCode] = await Promise.all([
      drainCapped(proc.stdout, opts?.onStdout),
      drainCapped(proc.stderr),
      proc.exited,
    ]);
    return { stdout: out.text, stderr: err.text, exitCode, timedOut: false, truncated: out.truncated };
  } finally {
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

export const passthroughSkillSandbox: SkillSandbox = {
  run: (argv, cwd, env, settings, opts) => runPassthrough(argv, cwd, env, settings, opts),
};

/** 隔离能力 none → passthrough；srt → 真沙箱。 */
export function selectSkillSandbox(platform: NodeJS.Platform = process.platform): SkillSandbox {
  return runtimeFeatures(platform).skillIsolation === "none" ? passthroughSkillSandbox : realSkillSandbox;
}
