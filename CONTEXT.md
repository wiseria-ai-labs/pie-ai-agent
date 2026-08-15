# Pie

Pie 是一个 BYOK Chrome 扩展（Manifest V3），让用户用自己的 API key 获得 AI 浏览器 agent 能力。本文件是领域术语表（glossary），只收本项目特有、易混淆的概念，不含实现细节。

## Scheduling

**Schedule**:
一条定时计划——一段 prompt 加调度参数（startAt / intervalMinutes / maxRuns），到点自动跑一个完整的常规 agent 任务。
_Avoid_: Loop（"Loop" 专指 agent 的 ReAct 循环 `runAgentLoop`，两者绝不可混用）, Cron job, Timer, Task

**Run**:
一条 Schedule 的某一次到点执行。每个 Run 有稳定的 recordId，1:1 对应一个 Session。
_Avoid_: Execution, Tick, Iteration, Trigger

**recordId**:
一个 Run 的稳定标识，独立于 sessionId，作为"事后针对某次执行再发起操作"的锚点。
_Avoid_: runId（口语可用，但持久字段统一叫 recordId）

**headless run**:
不依赖 side panel / port 的后台 agent 执行路径；Schedule 到点时由 chrome.alarms 唤醒 service worker 来跑，side panel 开不开都不影响。
_Avoid_: background task, detached run

## Local Daemon Bridge

（spec `docs/specs/2026-07-05-local-daemon-bridge.md`；ADR 0005/0007/0009/0010）

**Daemon**:
常驻本地进程（`pie daemon`，macOS launchd 拉起），扩展与本地世界的桥；是浏览器侧与本地 Agent 侧两个客户端的**会合点**，持有授权账本 + audit + skill 执行器 + MCP 代理 + agent runner。
_Avoid_: server, service, backend（"daemon" 专指这个进程，别泛化）

**Host**:
`pie host`——Chrome 用 `connectNative` 按需 spawn 的**薄透传**进程，只在 Chrome stdio framing ↔ daemon IPC 之间搬字节，无业务逻辑，不 spawn daemon。IPC 形态（unix socket / named pipe）是 runtime 内部的事。
_Avoid_: proxy, bridge（"Bridge" 指整条通道，不是这个进程）, native host（口语可用，持久命名用 Host）

**Bridge**:
扩展 ↔ host ↔ daemon 这**整条双向通道**及其 JSON-RPC 协议，不是某个单独进程。协议口径见「wire」。
_Avoid_: 用 Bridge 指 Host 进程

**wire（桥协议）**:
接口（扩展、顶栏、托盘）与 runtime（daemon）之间的唯一合同，权威源 `src/types/local-bridge.ts`。只传语义：id / label / kind / 能力 / 用户内容；不传系统怎么做（绝对路径、pid、平台下载 URL、win32 布尔）。runtime 自己 handle detect、唤起、沙箱、更新（ADR 0010）。
_Avoid_: 在协议里带 `platform`、把宿主机路径或杀进程手段做成返回契约

**interface / runtime**:
interface = 说协议的客户端（侧栏、SW、顶栏、托盘）。runtime = 本机执行侧（daemon；host 只搬字节）。安装器与打包不是 runtime。
_Avoid_: SystemAdapter（不收成一个适配神对象）, 把安装卸载并进 runtime

**round-trip**:
接力形态之一——侧栏发起，daemon spawn `claude -p` headless，输出**流式回传**侧栏，用户不离开浏览器；子 Agent 结果作单条 observation 回 Pie loop。风险住在每次变的 prompt/cwd，故**永远弹卡、不持久授权**。
_Avoid_: hand-off（交棒到终端、不回传，是另一形态）, sub-agent

**hand-off**:
接力形态之一——把 brief（及可选文件）交给本机已装的交互式 agent，ownership 移到该 agent 和用户；fire-and-forget，结果不回传。落盘位置与如何打开 app / 终端由 runtime 决定，不进协议合同。
_Avoid_: round-trip, 把 `open -a` / `start` / handoff 绝对路径写成产品语义

**platform detect（平台检测）**:
「本机装了哪个本地 agent」的底层探测。mac 与 Windows 各写各的模块（`detect-darwin` / `detect-win32`），安装落点按平台调研，不可互推。上层 `list_agents` / handoff 的 id 与语义统一（ADR 0009）。
_Avoid_: 用一份路径表同时描述两个平台

**agent brand**:
用户心智里的一个本地 Agent——Claude / Codex / Cursor / OpenCode / Pi。设置开关、启用偏好、确认卡上的「选哪个 Agent」都按品牌。任一形态检出即该品牌可用。
_Avoid_: 把 App / Terminal 当成两个 Agent；用 provider / model 指本地 Agent

**agent form**:
一个品牌的交棒外壳：`app` 或 `terminal`。检测路径、launch 命令、`handoff_to_agent.target` 仍是形态 id（`claude-app` / `claude-terminal` …）。只在确认卡、且该品牌两种形态都装了时才让人再选一次。
_Avoid_: 在设置里给形态单独开关；把 form 叫 mode（`HandoffResult.mode` 是 launch 结果，不是身份）

**bridge session**:
反向调用（本地 Agent → Pie）时 daemon 侧建的 ephemeral session，仅作 CDP ownerToken / sandbox 记账；操作按 tabId 直打**真实活跃 tab**，不绑某个 Pie session 的 pinned tab。
_Avoid_: pinned tab session

**grant（授权账本）**:
daemon 持有的持久授权（`~/.pie/grants.json`），只记 `skill:<id>:<permsHash>` 和 `mcp:<server>[:<tool>]` 两类；批准发生在扩展 HITL 卡，强制与持久在 daemon（ADR 0006）。
_Avoid_: permission, consent（"cdp-consent" 等 panel-request kind 是 UI 层，grant 是 daemon 持久层）

## Skills & Kits

**Skill**:
一份「怎么做」的包——SKILL.md 说明 + 可选 `scripts/`。不负责提供 ffmpeg / yt-dlp 这类运行时。
_Avoid_: 用 skill 指代本机二进制；把 kit 叫成 skill 的附件

**Kit（套件）**:
一份「做它需要什么」的运行时包——按平台打包的二进制 / 解释器，带版本和校验。多个 skill 可共享同一 kit。用户看见的是套件展示名，不是 yt-dlp。
_Avoid_: helper、dependency（对用户）；把 brew 包装叫 kit

**requires**:
Skill 对 Kit 的声明（kit id + 主版本），装 skill / 首次跑脚本时解析。不是沙箱权限信封。
_Avoid_: metadata.pie.network/write（ADR 0007 已删）；在 skill 里列举二进制文件名
