# ADR 0011：Agent 检测按平台解耦；改支持列表先调研该平台安装落点

## 背景

Pie Link 在 mac 与 Windows 上各自跑一份 daemon。上层契约统一（`list_agents` / `handoff_to_agent` / `run_local_agent`，wire 只传 id）。底层「这台机器上有没有装 Cursor / Codex / Claude」完全不是同一套事实：

- mac：`/Applications/*.app` + login-shell `which`
- Windows：Uninstall 注册表（NSIS 整机/用户级）、AppModel 仓库（Store/MSIX）、`where` + 知名 `.exe` 路径

#23 真机验收里，同一品牌在两边的安装器不是同构的：Cursor 官网包可落到 `Program Files`，Codex/ChatGPT 桌面 **没有** 传统直装包，官网 installer 仍是 Store/MSIX。把 mac 路径或「用户级 NSIS 猜测」抄到 Windows，设置页会永久显示未安装。

## 决定

1. **改 agent 支持列表（加品牌、加形态、改路径）之前，必须按平台分别调研安装信息**，不能从另一边类推。至少弄清：发行渠道（dmg / pkg / NSIS / MSIX / winget / brew）、默认落点、如何从系统查出已装、唤起命令是否吃文件夹参数。没在该平台真机验证过的命令/路径不得进默认可用集（`verified: false`）。

2. **检测模块按平台拆开，互不调用。**  
   - mac：`daemon/src/detect-darwin.ts`（bundle + which / binPaths）  
   - Windows：`daemon/src/detect-win32.ts`（Uninstall → Appx → appPaths；terminal 走 `where` / binPaths）  
   上层 `detectAgents` 只按 `platform` 分发。mac 检测不得读 Windows 注册表/Appx 字段；Windows 检测不得认 `/Applications`、不得跑 login-shell PATH。

3. **只有上层功能统一。** 候选 id / label / kind、handoff 语义、HandoffCard 预选，跨平台同一套。候选表本身已经分 `AGENT_CANDIDATES` 与 `WINDOWS_AGENT_CANDIDATES`；继续保持两张表，不要合并成「一份数据加 if platform」。

## 被拒的备选

- **一张候选表、detect 里到处 `if (win32)`**：字段和探测源会缠在一起，改 Windows Store 探测容易碰坏 mac bundle 探测。
- **Windows 复用 mac 的 `appPaths` 思维**（只写死一条用户级路径）：已被 #23 真机打脸。

## 下游

加一条 Windows app = 先查 Uninstall DisplayName 与是否 Store 包，再决定 `uninstallNames` / `appxPackagePrefix` / 回落 `appPaths`。加一条 mac app = 先确认 bundle id 与 `/Applications` 落点。Parallels 共享的 `*(Mac)` 快捷方式两边都不算已装。
