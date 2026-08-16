// 扩展 ↔ daemon 桥协议。此文件是唯一权威源；daemon 相对 import，不复制。
// 加字段只增不改语义；破坏性变更才 bump PROTOCOL_VERSION（spec §7）。
// 口径（ADR 0012）：只传语义（id / kind / 能力 / 用户内容），不传系统怎么做
// （绝对路径、pid、平台 URL、win32 布尔）。存量违规字段见 ADR 0012 债务表，新代码不得当合同。

// v1→v2（ADR 0007）：授权模型从 grant 信封换成 agent 确认层。破坏点 = run_skill_script
// 不再收 grantApproved/approvedEnvelopeHash、daemon 不再回 needs_authorization、
// list_grants/revoke_grant 下线。daemon 对声明 v1 的客户端拒绝 run_skill_script 并引导升级。
export const PROTOCOL_VERSION = 2;

/** daemon 声明它能处理的方法。扩展按此决定装配哪些本地工具。 */
export const BRIDGE_CAPABILITIES = [
  "run_local_agent",
  "handoff_to_agent",
  "list_agents",
  "skill_fs",
] as const;
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

// ── 握手 ──────────────────────────────────────────────────────────────
export interface HelloRequest {
  id: string;
  method: "hello";
  params: { protocolVersion: number };
}
/** 脚本执行隔离能力（ADR 0012）：srt = 有围栏；none = 以用户账户直跑。 */
export type SkillIsolation = "srt" | "none";

export interface HelloResponse {
  id: string;
  ok: true;
  // daemonVersion 加法演进（PROTOCOL_VERSION 不动，spec §6）：旧 daemon 不给此
  // 字段 → 扩展视为版本过旧，走软升级提示。
  result: {
    protocolVersion: number;
    capabilities: string[];
    daemonVersion?: string;
    /** 加法（ADR 0012）：脚本隔离能力。旧 daemon 不给 → 确认卡用既有通用披露。 */
    skillIsolation?: SkillIsolation;
    /** 加法（ADR 0012）：是否支持 apply_update。旧 daemon 不给 → 视为未知。 */
    selfUpdate?: boolean;
  };
}

// ── run_local_agent ──────────────────────────────────────────────────
export interface RunLocalAgentParams {
  /**
   * 用户在 RunLocalAgentCard 上选的 headless 后端 agent id（**非 LLM 传入**，与
   * HandoffParams.target 同语义——被 untrusted 页面驱动的 LLM 不能诱导选后端）。
   * 缺省 = daemon 按候选表顺序取第一个「已装且有 headlessArgv」者（旧扩展/未选时不变）。
   * daemon 运行时校验它 ∈ 本次检测到的「已装 headless」集，非法值回描述性错误（不静默回落）。
   * 加法演进（PROTOCOL_VERSION 不动）：旧 Slice-0 扩展传 "claude" 是 claude-terminal 的 alias。
   */
  target?: string;
  prompt: string;
  /** 缺省 = daemon 建的临时 workspace ~/pie-handoffs/<slug>/ */
  cwd?: string;
}
export interface RunLocalAgentResult {
  output: string;
  exitCode: number;
  /** daemon 实际使用的 cwd（回填给卡片/audit） */
  cwd: string;
  /**
   * daemon 实际选中的 headless 后端（按候选表顺序取第一个「已装且有 headlessArgv」者）。
   * 加法演进（PROTOCOL_VERSION 不动）：observation 据此告诉 LLM 本次跑的是哪个本地 agent。
   * 旧 daemon 不回此字段 → optional，消费方缺省不显示后端名。
   */
  backend?: { id: string; label: string };
}

// ── list_agents ──────────────────────────────────────────────────────
/** daemon 静态候选表全量（含未安装项，installed 标注检测结果——settings 页渲染"未安装"态需要）。 */
export interface ListAgentsResult {
  agents: {
    id: string;
    label: string;
    installed: boolean;
    kind?: "app" | "terminal";
    /**
     * 该 agent 可作 run_local_agent 的 headless 后端（声明了 headlessArgv）。app 形态恒 false。
     * 加法演进（PROTOCOL_VERSION 不动）：旧 daemon 不给此字段 → 消费方回落 kind === "terminal" 代理。
     */
    headless?: boolean;
  }[];
}

// ── handoff_to_agent ─────────────────────────────────────────────────
export interface HandoffParams {
  /**
   * agent id（用户在 HandoffCard 上选的，非 LLM 传入）。daemon 运行时校验
   * ∈ 本次检测到的 id 集；旧 wire 值 "claude" 是 claude-terminal 的 alias。
   */
  target: string;
  /** markdown brief，daemon 落盘为 context.md 供交互式 session 读取 */
  context: string;
  /** 可选：随交棒 stage 进 handoff 目录的文件（名字取 basename，防遍历） */
  files?: { name: string; content: string }[];
}
export interface HandoffResult {
  /**
   * @deprecated ADR 0012：绝对路径不是协议合同。daemon 仍回填（加法，旧客户端可读），
   * 新接口不得消费（observation / UI 不得展示或依赖）。
   */
  dir: string;
  /** terminal = 自动开跑；app = App 已打开但需用户发一句话启动 */
  mode: "terminal" | "app";
  /**
   * 加法（PROTOCOL_VERSION 不动）：app 实际怎么打开的。
   * deeplink = 官方深链预填了引导语；open-a = `open -a` / 回落 / Cursor。
   * 旧 daemon 缺省 → 消费方按 open-a（不要谎称预填）。
   */
  appLaunch?: "deeplink" | "open-a";
}

// ── skill_fs ──────────────────────────────────────────────────────────
/** list_skills 每项：catalog 呈现所需的结构化摘要。
 *  ADR 0007：SKILL.md metadata.pie.* 能力声明整套下线——沙箱降为固定基线（网络全放
 *  + 写限 workspace + env 白名单），不再有 per-skill 声明的 network/write 能力。 */
export interface SkillSummary {
  name: string;
  /** 展示名 = frontmatter.name（目录名产不出 ASCII slug 时两者不同，如中文名
   *  skill 迁到 hash 目录）；缺省同 name。身份/调用一律用 name（目录名）。 */
  displayName?: string;
  description: string;
  /** scripts/ 下可执行文件的相对名（如 "fetch.ts"）；run_skill_script 的 allowlist */
  runnableScripts: string[];
  /** 包内文件相对路径（POSIX 分隔；排除 workspace/ 与 .runs/ 及点文件；上限 200） */
  files: string[];
  /** 来源根：主根 ~/.pie/skills = "pie"，只读副根 ~/.agents/skills = "agents"。
   *  optional 加法字段：旧 daemon 不给 → 扩展按 "pie" 处理（无 badge）。 */
  source?: "pie" | "agents";
}
export interface ListSkillsResult {
  skills: SkillSummary[];
}

export interface ReadSkillFileParams {
  name: string;
  /** skill 目录内相对路径（如 "SKILL.md" / "references/foo.md"） */
  path: string;
}
export interface ReadSkillFileResult {
  content: string;
}

export interface RunSkillScriptParams {
  name: string;
  /** 必须 ∈ 该 skill runnableScripts */
  entry: string;
  /** CLI 风格参数 */
  args?: string[];
  /** 调用会话 id（不可信输入，daemon 侧 assertSessionId 做 uuid 形状校验防路径穿越）。
   *  脚本 cwd = ~/.pie/sessions/<sessionId>/workspace/，产物按 session 隔离。 */
  sessionId: string;
  /**
   * 扩展生成的本次 run 标识（加法，PROTOCOL_VERSION 不动）。
   * 用于 poll_skill_run / kill_skill_run 在阻塞的 run_skill_script 期间并发查询/中止。
   * 旧扩展不传 → daemon 自生成，进度/中止不可达，行为与原来一致。
   */
  runId?: string;
}

/** poll_skill_run：查一次长任务进度。run 已结束或不存在 → state "done"（完成竞态，不是错误）。 */
export interface PollSkillRunParams {
  runId: string;
}
export interface PollSkillRunResult {
  state: "queued" | "running" | "done";
  elapsedMs: number;
  /** 末尾约 8KB，已折叠 yt-dlp/ffmpeg 的 \\r 进度刷屏。不可信，UI 当纯文本。 */
  stdoutTail: string;
}

/** kill_skill_run：中止一次 in-flight / queued run。幂等（未知 runId 也 ok）。 */
export interface KillSkillRunParams {
  runId: string;
}
export interface KillSkillRunResult {
  ok: true;
}

/** Pie 代管的本机 helper（下到 ~/.pie/bin，不要求用户自己 brew/apt）。 */
export type SkillHelperId = "yt-dlp" | "ffmpeg";

/** skill id → 跑脚本前必须在 PATH / ~/.pie/bin 里的 helper。扩展与 daemon 共用。 */
export const SKILL_REQUIRED_HELPERS: Readonly<Record<string, readonly SkillHelperId[]>> = {
  // video-parser withdrawn until Skill + Kit lands. No skill hard-requires
  // named binaries in the meantime.
};

export interface SkillHelperStatus {
  id: SkillHelperId;
  present: boolean;
  /** 解析到的绝对路径；缺省 = 未找到。 */
  path?: string;
  /** pie-bin = ~/.pie/bin 里 Pie 下的；path = 用户自己装的。 */
  source?: "pie-bin" | "path";
}

export interface ListSkillHelpersResult {
  helpers: SkillHelperStatus[];
  /** 新 daemon 恒 true。旧 daemon 无此 method → 扩展回落「请升级 Pie Link / 自行安装」。 */
  installable: true;
}

export interface EnsureSkillHelpersParams {
  /** 要补齐的 helper；缺省 = 全部已知 helper。 */
  ids?: SkillHelperId[];
}
export interface EnsureSkillHelpersResult {
  helpers: SkillHelperStatus[];
}
export interface RunSkillScriptResult {
  /** 脚本 stdout，调用方包 <untrusted_skill_content> */
  output: string;
  truncated?: boolean;
  /** 本次运行写进 session workspace 的产物（mtime >= startedAt），path 相对 workspace 根。
   *  optional 加法字段：无产物时省略（PROTOCOL_VERSION 不动，旧 daemon 不给 → 扩展不列清单）。 */
  outputs?: { path: string; bytes: number }[];
  /** outputs 超过封顶（50）被截断 */
  outputsTruncated?: boolean;
}

/** read_session_file：读回本 session workspace 内的产物（safeRelPath 锁在 workspace 内）。 */
export interface ReadSessionFileParams {
  sessionId: string;
  /** session workspace 内相对路径（如 "out.csv"） */
  path: string;
  /** 字符偏移续读（D8）：从第 offset 个字符起返回，缺省 0。 */
  offset?: number;
  /**
   * 加法：utf8（默认，文本产物）或 base64（图片等二进制，给 vision 喂帧）。
   * 旧 daemon 忽略此字段，按 utf8 读。
   */
  encoding?: "utf8" | "base64";
}
export interface ReadSessionFileResult {
  content: string;
  /** content 被单次上限（READ_OUTPUT_CAP，256K 字符）截断——还有更多可用 offset 续读。 */
  truncated?: boolean;
  /** 文件总字符数（truncated 时供 LLM 判断还剩多少）。加法字段：旧 daemon 不给。 */
  totalLength?: number;
  /** 与请求 encoding 回显；缺省按 utf8。 */
  encoding?: "utf8" | "base64";
}

/** read_session_file 单次返回上限（D8）：256K 字符。超限截断 + truncated 标记，
 *  LLM 用 offset 续读。既防大转写文本直灌 LLM context，也守住 native messaging 单帧上限。 */
export const READ_OUTPUT_CAP = 256 * 1024;

/** delete_session_workspace：硬删 session / 归档时清 workspace（幂等）。 */
export interface DeleteSessionWorkspaceParams {
  sessionId: string;
}
export interface DeleteSessionWorkspaceResult {
  deleted: boolean;
}

export interface WriteSkillFile {
  /** skill 目录内相对路径 */
  path: string;
  content: string;
}
export interface WriteSkillParams {
  name: string;
  files: WriteSkillFile[];
}
export interface WriteSkillResult {
  /** 落盘的 skill 目录绝对路径 */
  dir: string;
}

export interface DeleteSkillParams {
  name: string;
}
export interface DeleteSkillResult {
  deleted: boolean;
}

/** 固定基线沙箱摘要（ADR 0007）：授权已移到 agent 确认层，沙箱不可声明不可配。
 *  audit 每条记这份摘要作为「这次是在什么隔离基线下跑的」的知情权凭据。 */
export interface SandboxBaseline {
  /** 网络维度：固定全放（"open"）。 */
  network: "open";
  /** env 白名单版本号（擦除策略变更时递增，audit 可追溯当时的擦除口径）。 */
  envAllowlist: string;
  /**
   * @deprecated ADR 0012：跑后 audit 仍可记。跑前披露走 hello.skillIsolation，
   * 新确认卡不得靠此字段猜平台。
   */
  unsandboxed?: boolean;
}

/** audit.jsonl 单行（daemon 每次脚本执行追加）。 */
export interface AuditEntry {
  ts: number;
  skillName: string;
  entry: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
  /** 固定基线沙箱摘要（加法字段：旧行无此字段，list_audit 契约过滤只认 skillName/entry）。 */
  sandbox?: SandboxBaseline;
}
export interface ListAuditParams {
  /** 返回最近 N 条（默认 20，上限 200） */
  limit?: number;
}
export interface ListAuditResult {
  entries: AuditEntry[];
}

// ── 自更新（check_update / apply_update，#403）──────────────────────────
// daemon 真身住 ~/.pie/bin/pie（用户可写），更新 = 下载新二进制 → 验签 → 原子
// rename 覆盖 → 由顶栏 app kickstart 重启。零提权、零安装器、零密码。
// 加法演进：两个新 method 只增不改语义，PROTOCOL_VERSION 不动。

/** `pie-link-latest.json`（release asset，固定名，靠 /releases/latest/download/ 稳定 URL 命中）。 */
export interface PieLinkLatest {
  version: string;
  macos: { url: string; sha256: string };
  windows: { url: string; sha256: string };
}

/** check_update 结果：当前 vs 最新版本比较。 */
export interface CheckUpdateResult {
  current: string;
  latest: string;
  /** latest > current（三段 semver 比较） */
  available: boolean;
  /**
   * @deprecated ADR 0012：下载 URL 不是协议合同（runtime 内部选发布物）。
   * 新客户端只读 available / latest / supported。
   */
  url?: string;
  /** 是否支持 apply_update 一键换文件。与 hello.selfUpdate 同义。 */
  supported: boolean;
}

/** apply_update 结果：换文件成功后回新版本号，调用方决定何时重启。 */
export interface ApplyUpdateResult {
  /** 替换后磁盘上的新版本号（= latest.version） */
  version: string;
  /**
   * @deprecated ADR 0012：绝对路径不是协议合同。daemon 仍回填，新客户端不得依赖。
   */
  path: string;
}

/** shutdown 结果：runtime 已接受停止请求，回包后自行退出。 */
export interface ShutdownResult {
  stopping: true;
}

// ── status（顶栏 app / 诊断用）────────────────────────────────────────
export interface StatusResult {
  version: string;
  uptimeSec: number;
  /** 有活跃的扩展 host 连接（发过 hello 的 socket） */
  extensionConnected: boolean;
  runningSkills: { name: string; startedAt: number }[];
  /**
   * @deprecated ADR 0012：pid 不是退出合同。新客户端发 `shutdown`。
   * daemon 仍回填，旧托盘可作回落。
   */
  pid?: number;
}

// ── 通用信封 ──────────────────────────────────────────────────────────
export interface BridgeRequest {
  id: string;
  method:
    | "hello"
    | "run_local_agent"
    | "handoff_to_agent"
    | "list_agents"
    | "list_skills"
    | "read_skill_file"
    | "run_skill_script"
    | "poll_skill_run"
    | "kill_skill_run"
    | "list_skill_helpers"
    | "ensure_skill_helpers"
    | "read_session_file"
    | "delete_session_workspace"
    | "write_skill"
    | "delete_skill"
    | "list_audit"
    | "status"
    | "check_update"
    | "apply_update"
    | "shutdown";
  params: unknown;
}
export type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };
