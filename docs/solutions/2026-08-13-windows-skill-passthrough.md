# Windows Pie Link 真机验收 + skill 沙箱决策（issue #12）

日期：2026-08-13 ｜ 环境：Parallels `Windows 11`（ARM64 + x64 模拟）｜ 制品：`pie-link-setup-0.2.x.exe`，构建自 main（daemon 四件套合批后）

## TL;DR

Windows 全链路真机验收跑到 skill/沙箱环节，坐实 **srt-win 沙箱在 Windows 上不可用**（脚本根本读不到、且每次调用 ~30s 阻塞）。经拍板：**Windows 放弃 srt 沙箱，skill 脚本改 passthrough（无沙箱、以用户账户权限直跑）+ 显式风险披露 + 知情同意**——诚实披露风险优于功能缺失。已实现并真机验过 D 全链路（脚本能跑、快、有审计），mac/Linux 保留 srt 不变。

## 验收结果（A–E）

| 环节 | 结论 |
|---|---|
| **A 安装** | ✅ 全绿。HKLM NM 键 ×2 / manifest json / 开始菜单 / Run key / 沙箱账户 provision / vc_redist / 托盘自启都在位；HKCU 遮蔽键被安装器清掉。SmartScreen 摩擦源于未签名（spec decision 9 已接受，非缺陷）。 |
| **B 连接** | ✅ Chrome + Edge 都连上，进程 `ExecutablePath` 实证 = `C:\Program Files\Pie Link\pie.exe`；doctor 分项全绿。 |
| **C agent/handoff** | 部分。host 兜底拉起 ✓、单实例互斥 ✓（无 Bun panic）、逃逸浏览器 job object ✓。detectAgents=none（候选表全 `verified:false` 草案，W-1）。handoff launch 层 mac-only 未实现（W-2）。 |
| **D skill** | 起初 srt 下**全线阻断**（见 W-4）；改 passthrough 后 **✅ 全绿**（下文）。 |
| **E 沙箱围栏** | Windows 改为**不承诺沙箱 + 披露**，不再是发版阻断项。 |

## 关键发现

- **W-4（原 P0）**：srt-win 下 `run_skill_script` 全线 `EPERM reading ...\scripts\*.ts`。icacls 实证：srt `acl grant` 只给**被授叶子路径 + 子树**加 `srt-sandbox:(RX)` ACE，**所有祖先目录 NO-ACE**；受限令牌中和了 `Users/Everyone:(RX)`，沙箱进程无法遍历/向上扫（bun 找 bunfig/package.json）到脚本。
- **W-6（P1，新）**：`checkWindowsSandboxReady()`（~30s WFP verify）在**每次** `run_skill_script` 都跑、且先于 grant 检查，单线程阻塞。审计实证：srt 旧跑 22–30s 且全 exit=1。
- **W-5**：WFP verify 偶发直接挂到 30s SIGTERM → `sandbox_not_ready`（fail-closed）。
- 上游对照（研究）：srt-win 仍 alpha（v0.0.71）；**#457** profile 路径 acl stamp ~30s/path、**#402** additive-allow 写围栏可被 `Authenticated Users` 继承权绕过；Claude Code 原生 Windows 不开沙箱（推 WSL2），Codex 最成熟（专用账户 + 受限令牌 + 防火墙，网络阻断仅提权模式）。

## 决策：Windows = passthrough + 风险披露

srt-win 交付的是一个**有洞（#402）、读不到脚本（W-4）、还每次 30s（W-6）**的假沙箱。与其如此，不如**明说"Windows 无沙箱、请只跑你信任的 skill"并取得知情同意**。业界常态（VS Code tasks / npm postinstall / git hooks 皆无沙箱）。

**存储守约定不变**（`~/.pie/skills` 主根 + `~/.agents/skills` 只读副根，对齐 Anthropic Agent Skills）；只有**执行**层在 Windows 改 passthrough。

## 实现（daemon 0.2.1）

- `daemon/src/skill-sandbox.ts`：`passthroughSkillSandbox`（async `Bun.spawn` 直跑，无 srt / 无围栏 / 60s 超时 + 输出封顶）+ `selectSkillSandbox(platform)`（win32→passthrough，其余→srt）。
- `daemon/src/skill-exec.ts`：`sandbox = selectSkillSandbox()`；移除 Windows readiness 门（默认恒 ready，消除 W-6 的 30s verify）；grant payload 加 `unsandboxed: win32`。
- `src/types/local-bridge.ts`：`SkillAuthPayload.unsandboxed?`（面板据此渲染风险披露）。

## 验证证据

- daemon `bun test` 333 pass；扩展 `pnpm typecheck` 0 err。
- 真机（PF 部署 0.2.1，passthrough）：
  - `write-fence` `ok:true`：workspace/skill目录/家目录写 ALLOWED（无围栏，以用户权限），Program Files 写 BLOCKED（普通 NTFS 权限拒，非沙箱）；outputs 扫到 `inside.txt`。
  - `read_skill_output(inside.txt)` → 回读文件内容成功。
  - `list_audit` 前后对比：srt 旧跑 3 条 exit=1 + 22–30s；passthrough 新跑 **exit=0 + 6.5s**。

## 尚余跟进（非阻断，落 issue）

1. 面板渲染 `unsandboxed` 风险披露卡（daemon 已给信号，UI 未接）。
2. 安装器减包：去 `srt-win.exe` / `vc_redist.x64.exe`（~25MB）/ 装沙箱那次 UAC。
3. `pie doctor` 文案改「Windows 无沙箱」。
4. 设置里默认关的 opt-in 开关（显式、持久的风险接受）。
5. W-2：handoff launch 层 Windows 化（`.bat` 脚本 + `cmd /c start`/wt.exe，替换 mac-only 的 `#!/bin/bash` + osascript）。
6. F 升级 / G 卸载环节待补。
