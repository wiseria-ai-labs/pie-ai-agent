# ADR 0010：桥协议只传语义；runtime 不向接口暴露系统怎么做

## 背景

Pie Link 的接口（Chrome 扩展，以及顶栏 / 托盘这些同样走桥的客户端）和 runtime（`pie daemon`；`pie host` 仍是薄透传）之间，唯一合同是 `src/types/local-bridge.ts`。

mac 与 Windows 已是两份 runtime。检测按平台拆开（ADR 0009），但协议里仍有一批「本机怎么做」的字段：绝对路径、pid、按 OS 切的下载 URL、`unsandboxed` 这类平台布尔。接口一旦消费它们，就会按路径形状或 OS 分支写逻辑——下一台机器或下一种安装形态一变，设置页 / observation / 托盘就错。

本决定只定 **runtime ↔ 接口** 的口径。安装器、打包、商店上架不在范围内。

## 决定

1. **协议是边界。** 接口发方法与语义参数；runtime 自己做 detect、落盘、唤起、沙箱、更新、退出。接口不得根据 OS 名、路径形状、注册表、pipe / socket 差异做分支。判据：再加一个 OS，这个类型和所有接口消费方应能不动。

2. **可以过协议的：**
   - 身份与展示：agent `id` / `label`、skill `name`、`kind`（`app` | `terminal`）、`installed`、`headless`
   - 能力：`hello.capabilities`、版本号、以及具名能力（如「脚本是否有隔离围栏」「是否支持一键自更新」）。能力用产品语义命名，不写成平台名
   - 用户写的内容：`prompt`、`context`、文件的 basename + content
   - 授权需要用户看见的工作目录：**仅作为 `run_local_agent` 的入参**（卡上展示「要在哪跑」）
   - 会话工作区内的**相对路径**（`outputs[].path`、`read_session_file.path`）——这是协议内标识，不是宿主机绝对路径
   - 脚本 stdout 等不可信输出（按既有 `<untrusted_*>` 包装）
   - 产品身份：`SkillSummary.source`（`pie` | `agents`）这类双根来源，不是 OS 探测结果

3. **不可以过协议的（含错误文案）：**
   - 绝对宿主机路径当作合同（handoff 目录、skill 落盘目录、自更新二进制路径、失败时的 `start.bat` / `open -a` 指令）
   - 进程句柄当作操作手段（`status.pid` 给客户端去杀进程）
   - 平台键的发布物（`PieLinkLatest.macos` / `.windows`、`check_update.url` 按 OS 挑包）
   - 平台布尔或探测/唤起细节（`unsandboxed`、`win32`、注册表、`open -a`、`cmd /c start`）
   - `hello` / `status` 上报 `platform`

   客户端要「打开 handoff 目录」「退出 daemon」时，发语义方法（例如将来的 `reveal_handoff` / `shutdown`），由 runtime 执行。

4. **存量违规字段加法演进，不借本决定 bump `PROTOCOL_VERSION`。** 权威源里它们仍在，旧客户端继续能读。新代码不得再把它们当合同（observation、新 UI、托盘退出不得依赖绝对路径或 pid）。删除或改语义时再破坏性升级。

   当前债务（后续切片清，本 ADR 不改代码）：

   | 字段 / 出口 | 违规点 |
   |---|---|
   | `HandoffResult.dir` | daemon 仍回填（加法）；**新接口已停读**（observation 不再带路径） |
   | `RunLocalAgentResult.cwd` | 结果里回填绝对路径（入参 `cwd` 仍合法） |
   | `WriteSkillResult.dir` | 落盘绝对路径；调用方只用成败 |
   | `ApplyUpdateResult.path` | 二进制绝对路径 |
   | `StatusResult.pid` | daemon 仍回填；**新退出路径是 `shutdown`**（托盘 / 顶栏已切，旧 daemon 回落 pid） |
   | `CheckUpdateResult.url` + `PieLinkLatest` 的 macos/windows | 发布物仍在结果里（加法）；新客户端只读 `available` / `latest` / `supported`。握手另有 `selfUpdate` |
   | `SandboxBaseline.unsandboxed` | 仍进跑后 audit；**跑前披露走 `hello.skillIsolation`** |
   | handoff 失败 `message` | **已改为语义错误**（不含脚本 / 目录绝对路径） |

5. **runtime 内部继续按平台拆模块，不收成一个系统适配器。** ADR 0009 的检测分家仍然有效；唤起、PATH、更新、沙箱同样各写各的。协议稳定不等于 runtime 合成一个神对象。

## 与既有 ADR 的关系

- **ADR 0005**（会合点）不变：daemon 常驻、host 薄透传。0005 第 3 条把传输写成 unix socket，那是当时 mac 的 runtime 实现，**不是协议字段**。Windows 已是 named pipe。接口只认 `connectNative("ai.wiseria.pie")`，不得依赖「这是文件还是 pipe」。
- **ADR 0009**（检测按平台解耦）是本决定在 detect 上的特例。本决定把同一条规矩收到整条桥：上层统一的是方法与语义，不是路径表。
- **ADR 0007**（确认在 agent 层）不变。隔离能不能披露，靠握手上的具名能力，不靠协议里的 Windows 布尔。

## 被拒的备选

- **`hello` 带 `platform`，接口自己分支**：把 OS 知识搬进扩展 / 托盘，每个新客户端复制一份，和「再加一个 OS 接口不动」相反。
- **一个 SystemAdapter 包揽 detect + 唤起 + 安装卸载**：协议边界不需要这个对象；安装不在 runtime 范围；detect 已证明混居会互相踩。
- **立刻删 `dir` / `pid` 并 bump 协议**：口径和清债务分开。本决定先冻结「新代码怎么写」；存量字段跟一次破坏性发版再砍。

## 下游

加桥字段或方法之前先过第 1 条判据。detect / handoff / PATH / 更新 / skill 解释器与沙箱附属、IPC（`isPipe` + `claimIpc`）已按平台或能力拆开。不再收成一个系统适配器。
