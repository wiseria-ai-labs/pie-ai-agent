import { existsSync } from "fs";
import { listWindowsUninstall, type UninstallEntry } from "./windows-uninstall";
import { listWindowsAppx, type AppxPackage } from "./windows-appx";
import { detectDarwinAgents } from "./detect-darwin";
import { detectWindowsAgents } from "./detect-win32";
import { getDarwinUserPath, makeDarwinWhich } from "./user-path-darwin";
import { getWindowsUserPath, makeWindowsWhich } from "./user-path-win32";

export { parseShellPath } from "./user-path-darwin";
export {
  parseRegQueryPath,
  mergeWindowsPath,
  isWindowsAppsStub,
  parseWherePath,
} from "./user-path-win32";

/**
 * 静态候选表 = 唯一 launch 权威：spawn 的命令 / app 路径只住在这里，绝不来自 wire 或
 * LLM 参数（wire 上只传 id，daemon 用 id 查表）。加新 agent = 在对应平台表加一行，
 * **必须先在该平台真机上调研安装落点并验证命令**——mac 与 Windows 安装信息不可互推。
 * 检测实现分 `detect-darwin.ts` / `detect-win32.ts`，互不调用（ADR 0011）。
 *
 * 顺序即 HandoffCard 的预选顺序：品牌分组，每组 app 在前（app 无 shell、无 TCC，launch 最稳）。
 *
 * 不在表里的：Hermes（没有"交互式 + 自动带初始 prompt"的形态，-z 是 headless 打印即退，
 * hermes chat 无法注入初始 prompt）、Openclaw（gateway 架构，与 exec start.command 范式不同构）。
 */
export interface AgentCandidate {
  id:
    | "claude-app"
    | "claude-terminal"
    | "codex-app"
    | "codex-terminal"
    | "cursor-app"
    | "cursor-terminal"
    | "opencode-terminal"
    | "pi-terminal";
  label: string;
  kind: "app" | "terminal";
  /** terminal：检测用的 bin 名（spawn 用 DetectedAgent.path，不是这个） */
  bin?: string;
  /** terminal：argv 模板，"{prompt}" 占位。位置参数 vs flag 的差异只是数据。 */
  argv?: string[];
  /**
   * terminal：headless（非交互，一次性跑完回传 stdout）的 argv 模板，"{prompt}" 占位。
   * 与交互式 `argv` 同构但形态不同——headless 无人可批工具调用，故各家在此带上「跳权限/
   * 自动放行」flag（用户已在 run_local_agent 授权卡上批过 prompt+cwd，那张卡就是闸）。
   * 只有声明了 headlessArgv 的候选才可作为 run_local_agent 后端；app 形态无此字段（无 CLI）。
   */
  headlessArgv?: string[];
  /**
   * terminal：官方安装器的知名落点（"~" 开头，detect 时展开）。PATH 探测 miss 才回落——
   * 常规安装完全可能不进 login shell PATH（真机实证：opencode 装在 ~/.opencode/bin 而
   * rc 没配 PATH），不能要求用户自己配。PATH 命中永远优先（用户自装位置说了算）。
   */
  binPaths?: string[];
  /** app：按优先级探，命中第一个存在的；spawn 用命中的绝对路径。 */
  appPaths?: string[];
  /**
   * Windows app：Uninstall 注册表 DisplayName 精确匹配（大小写不敏感）。
   * 用户级 NSIS（`~\AppData\Local\Programs\...`）和整机 NSIS（`C:\Program Files\...`）
   * 都写卸载项；比写死 appPaths 准。开始菜单 / Parallels 共享 Mac App 不进这张表。
   */
  uninstallNames?: readonly string[];
  /** Windows app：DisplayIcon / InstallLocation 下可接受的 exe 文件名。 */
  uninstallExes?: readonly string[];
  /**
   * Windows Store / MSIX：AppModel 包名前缀（如 `OpenAI.Codex`）。
   * 命中 `...\Packages\<prefix>_*` 后拼 `appxRelExes`。
   */
  appxPackagePrefix?: string;
  /** 相对 PackageRootFolder 的 exe（正斜杠或反斜杠均可）。 */
  appxRelExes?: readonly string[];
  /** app：目录内的约定引导文件名（无深链或深链回落时靠它引导）。 */
  convention?: "CLAUDE.md" | "AGENTS.md";
  /**
   * app：有则走深链（打开 + 目录 + 预填短引导语，不自动发送）；无则 `open -a` + convention。
   * 模板里 `{prompt}` / `{dir}` 占位，插入前 URL-encode。
   */
  deeplink?: {
    template: string;
  };
  /**
   * `false` = 该条命令/路径尚未在对应平台真机验证过——**detectAgents 默认排除**
   * （「未验证条目不得默认启用」，见 #364）。字段缺省视为已验证（mac 8 条历史条目无需触碰）。
   * Windows 表从零点亮：草案条目先落码（bin/flag 用跨平台已知语义），逐条真机验证
   * （PR need-human-test）通过后才把该条 `verified` 翻真、进入默认可用集。
   */
  verified?: boolean;
}

export const AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-app", label: "Claude Code (App)", kind: "app",
    appPaths: ["/Applications/Claude.app"], convention: "CLAUDE.md",
    deeplink: { template: "claude://code/new?q={prompt}&folder={dir}" } },
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude",
    argv: ["{prompt}"], binPaths: ["~/.local/bin/claude"],
    // headless: `claude -p "<prompt>"`；--dangerously-skip-permissions 让 headless claude
    // 不因无人审批而卡在写操作上。
    headlessArgv: ["-p", "--dangerously-skip-permissions", "{prompt}"] },

  // Codex 与 ChatGPT app 已合并为同一 bundle（com.openai.codex——本机
  // /Applications/ChatGPT.app 的 bundle id 实测就是它，没有独立的 Codex.app）。优先
  // Codex.app（万一 OpenAI 再拆回来），回落 ChatGPT.app。显示名合并成 "Codex / ChatGPT"。
  { id: "codex-app", label: "Codex / ChatGPT (App)", kind: "app",
    appPaths: ["/Applications/Codex.app", "/Applications/ChatGPT.app"], convention: "AGENTS.md",
    deeplink: { template: "codex://new?prompt={prompt}&path={dir}" } },
  // --dangerously-bypass-approvals-and-sandbox：产品拍板（2026-07-14 验收）——交棒要
  // 「到手即跑」，目录确认会卡住每一次 handoff（目录每次新建，信任记忆无效）。代价是
  // 交棒后的 codex 会话无审批、无沙箱，风险由用户在交棒动作本身承担。
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex",
    argv: ["--dangerously-bypass-approvals-and-sandbox", "{prompt}"],
    // headless: `codex exec "<prompt>"`（exec 子命令 = 非交互一次性跑）。真机实证两处必须显式带上：
    // 1. --skip-git-repo-check：run_local_agent 的默认 workspace（~/.pie/handoffs/<slug>）是全新
    //    非 git 目录，缺此 flag codex 直接 `Not inside a trusted directory` exit 1。
    // 2. --sandbox workspace-write：exec 出厂默认沙箱是 read-only（无 ~/.codex/config.toml 覆盖时），
    //    agent 会因 "workspace is mounted read-only" 写不了文件；显式开 workspace-write 才可写 cwd。
    headlessArgv: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"] },

  // Cursor 是 IDE：app 形态打开的是一个只有 context.md + AGENTS.md 的工作区，
  // 用户 ⌘L 发一句话让 agent 接手（已知取舍，见 spec §6）。
  // CLI 是 cursor-agent —— /Applications/Cursor.app 里的 `cursor` 是 IDE 启动器，不是 agent。
  { id: "cursor-app", label: "Cursor (App)", kind: "app",
    appPaths: ["/Applications/Cursor.app"], convention: "AGENTS.md" },
  // 不加 --trust：help 说它能跳工作区信任提示，但真机实测「--trust can only be used
  // with --print/headless mode」，交互式 TUI 直接报错退出。claude/codex 也无同粒度
  // flag（codex 只有全跳审批+沙箱的 dangerously-bypass，不能替用户开）——三家统一保持
  // 首次进目录一次 y 确认，那是 agent 自身的安全机制。
  { id: "cursor-terminal", label: "Cursor (Terminal)", kind: "terminal", bin: "cursor-agent",
    argv: ["{prompt}"], binPaths: ["~/.local/bin/cursor-agent"],
    // headless: `cursor-agent -p "<prompt>"`；--force 跳过工具审批（headless 无人可批）。
    headlessArgv: ["-p", "--force", "{prompt}"] },

  // opencode 的交互式 TUI 用 --prompt 带初始 prompt（真机验证：自动发送，不是预填输入框）。
  { id: "opencode-terminal", label: "OpenCode (Terminal)", kind: "terminal", bin: "opencode",
    argv: ["--prompt", "{prompt}"], binPaths: ["~/.opencode/bin/opencode"],
    // headless: `opencode run "<prompt>"`；--auto 自动放行工具调用（headless 无人可批）。
    headlessArgv: ["run", "--auto", "{prompt}"] },

  // pi（badlogic/pi-mono coding agent）：位置参数，`pi "<prompt>"`。
  { id: "pi-terminal", label: "Pi (Terminal)", kind: "terminal", bin: "pi", argv: ["{prompt}"],
    // headless: `pi -p "<prompt>"`。-p（非交互）模式本就没有工具审批门控，工具直跑，无需任何跳权限
    // flag。不带 --approve：那个 flag 的真实语义是「信任项目本地文件（AGENTS.md 等）for this run」，
    // 不是自动放行工具调用；Pie 新建的 workspace 也不该默认 trust 本地文件。
    headlessArgv: ["-p", "{prompt}"] },
];

/**
 * Windows 候选表。顺序与 mac 同构：品牌分组、每组 app 在前、terminal 随后
 * （HandoffCard 预选 = 表序里第一个已装且启用的）。
 *
 * terminal 四条（#12）真机确认后默认启用。app 两条（#23）先查 Uninstall
 * 注册表（DisplayName → DisplayIcon / InstallLocation），再回落 appPaths。
 * app 两条已在本机 Windows 11 真机点亮（Cursor = Uninstall 注册表；
 * Codex/ChatGPT = AppModel Store 包）。不加 claude-app：官方 Windows `.exe` 落点未确认。
 */
export const WINDOWS_AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude",
    argv: ["{prompt}"],
    binPaths: ["~/.local/bin/claude.exe", "~/.local/bin/claude", "~/AppData/Roaming/npm/claude.cmd"],
    headlessArgv: ["-p", "--dangerously-skip-permissions", "{prompt}"], verified: true },

  { id: "codex-app", label: "Codex / ChatGPT (App)", kind: "app",
    uninstallNames: ["ChatGPT", "ChatGPT Desktop", "Codex"],
    uninstallExes: ["ChatGPT.exe", "Codex.exe"],
    appxPackagePrefix: "OpenAI.Codex",
    appxRelExes: ["app\\ChatGPT.exe", "app\\Codex.exe"],
    appPaths: [
      "~/AppData/Local/Programs/chat-gpt/ChatGPT.exe",
      "~/AppData/Local/Programs/ChatGPT/ChatGPT.exe",
      "~/AppData/Local/Programs/OpenAI/ChatGPT/ChatGPT.exe",
    ],
    convention: "AGENTS.md", verified: true },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex",
    argv: ["--dangerously-bypass-approvals-and-sandbox", "{prompt}"],
    binPaths: [
      "~/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe",
      "~/.local/bin/codex.exe",
      "~/AppData/Roaming/npm/codex.cmd",
    ],
    headlessArgv: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"],
    verified: true },

  { id: "cursor-app", label: "Cursor (App)", kind: "app",
    uninstallNames: ["Cursor"],
    uninstallExes: ["Cursor.exe"],
    appPaths: ["~/AppData/Local/Programs/cursor/Cursor.exe"],
    convention: "AGENTS.md", verified: true },
  { id: "cursor-terminal", label: "Cursor (Terminal)", kind: "terminal", bin: "cursor-agent",
    argv: ["{prompt}"],
    binPaths: [
      "~/.local/bin/cursor-agent.exe",
      "~/.local/bin/cursor-agent",
      "~/AppData/Roaming/npm/cursor-agent.cmd",
    ],
    headlessArgv: ["-p", "--force", "{prompt}"], verified: true },

  { id: "opencode-terminal", label: "OpenCode (Terminal)", kind: "terminal", bin: "opencode",
    argv: ["--prompt", "{prompt}"],
    binPaths: [
      "~/.opencode/bin/opencode.exe",
      "~/.opencode/bin/opencode",
      "~/scoop/shims/opencode.exe",
      "~/AppData/Roaming/npm/opencode.cmd",
    ],
    headlessArgv: ["run", "--auto", "{prompt}"], verified: true },
];

/** 平台分支的候选表（纯函数，可测）：win32 → Windows 表；其余 → mac 8 条。 */
export function agentCandidatesFor(
  platform: NodeJS.Platform = process.platform,
): readonly AgentCandidate[] {
  return platform === "win32" ? WINDOWS_AGENT_CANDIDATES : AGENT_CANDIDATES;
}

/**
 * 本机用户 PATH。detect 每次现探（装完新 agent 立刻可见）；skill 热路径走缓存版。
 */
export function getUserPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? getWindowsUserPath() : getDarwinUserPath();
}

let cachedUserPath: string | undefined;

/**
 * 缓存版 `getUserPath`：daemon 生命周期内只探一次。给 skill 脚本执行热路径用。
 */
export function getCachedUserPath(platform: NodeJS.Platform = process.platform): string {
  if (cachedUserPath === undefined) cachedUserPath = getUserPath(platform);
  return cachedUserPath;
}

export function resetCachedUserPath(): void {
  cachedUserPath = undefined;
}

/** 检测结果 = 候选 + 解析出的绝对路径。spawn 只许用 path（裸命令名依赖运行时 PATH，真机上会 not found）。 */
export type DetectedAgent = AgentCandidate & { path: string };

export interface DetectOpts {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  /** true = 连 `verified:false` 的草案条目也纳入（供 need-human-test 逐条点亮用）；默认排除。 */
  includeUnverified?: boolean;
  /** Windows app：注入 Uninstall 表。测试传入；生产 win32 现读注册表。 */
  uninstall?: UninstallEntry[];
  /** Windows Store 包：注入 AppModel 表。测试传入。 */
  appx?: AppxPackage[];
}

/** 平台对应的 which：win32 走 `where`，其余走 Bun.which。 */
function makeWhich(platform: NodeJS.Platform, userPath: string): (bin: string) => string | null {
  return platform === "win32" ? makeWindowsWhich(userPath) : makeDarwinWhich(userPath);
}

/** 每次调用现检测（which/exists 都便宜，PATH 探测 0.1s 级，无缓存必要）；保持表顺序。 */
export function detectAgents(opts?: DetectOpts): DetectedAgent[] {
  const platform = opts?.platform ?? process.platform;
  const userPath = opts?.which ? "" : getUserPath(platform); // 注入 which 时不必探 PATH
  const which = opts?.which ?? makeWhich(platform, userPath);
  const exists = opts?.exists ?? existsSync;
  const candidates = agentCandidatesFor(platform).filter(
    (c) => opts?.includeUnverified || c.verified !== false,
  );
  if (platform === "win32") {
    const injected = !!(opts?.exists || opts?.which);
    const uninstall = opts?.uninstall ?? (injected ? [] : listWindowsUninstall());
    const prefixes = agentCandidatesFor("win32")
      .map((c) => c.appxPackagePrefix)
      .filter((p): p is string => !!p);
    const appx = opts?.appx ?? (injected ? [] : listWindowsAppx(prefixes));
    return detectWindowsAgents(candidates, exists, which, uninstall, appx);
  }
  return detectDarwinAgents(candidates, exists, which);
}
