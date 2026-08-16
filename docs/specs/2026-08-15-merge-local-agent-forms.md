# 本地 Agent：品牌合并 + 确认卡选形态 + App 深链预填

> grilling 定稿 · 2026-08-15 · 状态：设计完成，待落 issue → 交云端实现
>
> 前置：`docs/specs/2026-07-14-more-local-agents.md`（8 条形态分列）。本 spec 改的是
> **身份与设置 / 确认卡 / App 启动协议**，不改 handoff 目录模型，不改 `run_local_agent`。

## 1. 结论摘要

本地 Agent 的用户身份从「形态」改成「品牌」。Claude / Codex / Cursor 不再在设置里拆成 App 一行、Terminal 一行；**任一形态检出即该品牌可用**。交棒确认卡先选品牌，两种形态都装了再选这次走 App 还是 Terminal，预选 App。

App 交棒的体验条定为 **预填，不自动发送**。Claude Desktop 与 Codex / ChatGPT 走官方深链，一次带上 handoff 目录和短引导语；用户在 App 里看一眼再按发送（Claude 还会确认一次目录）。Cursor App 没有「目录 + prompt」合一的官方协议，继续 `open -a` + `AGENTS.md`。Terminal 路径不动，仍然自动开跑。

daemon wire 继续只收形态 id（`claude-app` / `claude-terminal` …）。品牌合并发生在扩展的偏好与 UI。`PROTOCOL_VERSION` 不动，不抬 `MIN_DAEMON_VERSION`。

## 2. 拍板记录

| # | 决策 | 选择 |
|---|---|---|
| D1 | App 体验条 | 打开 + 带目录 + 预填 prompt 即达标。不追自动发送（官方都不给）。 |
| D2 | 设置页合并 | 一个品牌一个开关。形态不是设置项。 |
| D3 | 确认卡预选 | 双形态都装了：品牌下拉 + App/Terminal 分段；预选 App。不记上次选择。 |
| D4 | 本轮范围 | 品牌合并 + 确认卡选形态 + Claude / Codex 官方深链。Cursor 不硬拼。OpenCode Desktop、Windows App（#23）、`run_local_agent` 不进本轮。 |
| D5 | 预填内容 | 与 Terminal 同一句短引导语。完整 brief 只写 `context.md`。深链路径不另写约定文件。 |

## 3. 品牌与形态

**品牌（brand）** 是用户心智里的「这个 Agent」：Claude / Codex / Cursor / OpenCode / Pi。

**形态（form）** 是一次交棒的外壳：`app` 或 `terminal`。launch 命令、检测路径仍按形态走，和现在候选表一行对应。

| 品牌 id | 展示名 | 形态 id |
|---|---|---|
| `claude` | Claude Code | `claude-app` · `claude-terminal` |
| `codex` | Codex / ChatGPT | `codex-app` · `codex-terminal` |
| `cursor` | Cursor | `cursor-app` · `cursor-terminal` |
| `opencode` | OpenCode | `opencode-terminal` |
| `pi` | Pi | `pi-terminal` |

派生规则（实现用，表是真源）：形态 id 去掉末尾 `-(app|terminal)` 即品牌 id。OpenCode / Pi 没有 App 行，确认卡不露第二层。

**可用谓词**

- 品牌已装 = 任一形态 `installed`
- 品牌已启用 = 偏好 `null`（从未动过开关）或偏好数组含该品牌 id
- 品牌可用（设置开关可开、交棒列表可出现）= 已装 ∩ 已启用
- 某次交棒能选的形态 = 该品牌可用 ∩ 该形态已装
- `run_local_agent` 后端仍是形态级：已装 ∩ 品牌已启用 ∩ `headless`（旧 daemon 回落 `kind === "terminal"`）

## 4. 设置页

「管理本地 Agent」按品牌一行，不再 8 行。

- 主行：品牌图标 + 展示名 + 开关
- 副行：已装形态芯片（`App` / `Terminal`）+ 未装文案。两种都没装 → 不可开
- 总览（主视图已启用列表）同样按品牌收，副行只报已启用品牌下已装的形态

开关决策：`applyToggle` 的 `id` 改为品牌 id。启用时现检测把关——该品牌一种形态都没装就拒。`null` 偏好首次拨动时物化为「当前已装品牌全开」，再应用本次拨动。

## 5. 偏好与迁移

key 仍是 `enabled_local_agents`，**值从形态 id 改为品牌 id**。

读时归一化（幂等，写回可在下次 `set` 时做，不必单独 migration job）：

- `null` → 仍是「已装即启用」
- 数组里的 `claude-app` / `claude-terminal` → `claude`（并集去重）
- 已经是品牌 id 的项原样保留
- 老用户只开过 `claude-app`、关过 `claude-terminal`：并集后 Claude 整品牌为开。这是拍板：形态不再是设置维度

`filterUsableAgents` / `isAgentUsable` / `filterHeadlessBackends` 都经「形态 → 品牌」再和偏好比。单测必须覆盖：旧形态数组、新品牌数组、`null`、只装了一种形态。

## 6. 确认卡

`handoff-to-agent` 的 panel-request **仍返回形态 id**（daemon `target` 不变）。payload 改为按品牌分组，避免卡片自己猜：

```ts
{
  context: string;
  fileCount: number;
  brands: {
    id: string;       // "claude"
    label: string;    // "Claude Code"
    forms: { id: string; kind: "app" | "terminal" }[]; // 仅已装
  }[];
}
```

交互：

1. 品牌下拉（现有 `AgentSelect`，选项是品牌）。多于一个品牌才是下拉；只有一个就静态行。
2. 选中品牌的 `forms.length === 2` 时，其下出 App / Terminal 分段开关；`length === 1` 不露第二层。
3. 预选：列表第一项品牌（daemon 候选表顺序：品牌分组、每组 App 在前）+ 若双形态都在则 App。
4. 不记 MRU。
5. 「允许」提交当前品牌下当前形态的 form id。

卡片说明按形态分：

- Terminal：交棒后终端会自动开跑
- App：交棒后 App 打开并预填引导语，需用户发送（Claude 会先确认目录）。Cursor 无深链时文案收成「App 已打开该目录，需发送一句」

`run_local_agent` 卡不改：它只列 headless 后端，没有 App 形态。

## 7. App 启动协议

`handoff.ts` 在 `kind === "app"` 时按候选表数据分支。`PROTOCOL_VERSION` 不动；旧 daemon 继续走现在的 `open -a <path> <dir>`，行为合法，只是没有预填。

### 7.1 公共准备（所有形态）

与现在相同：建 `~/pie-handoffs/<date>-<slug>/`，写 `context.md`，stage 用户文件。短引导语仍是：

```
Read context.md in this directory for the handed-off context, then continue the task.
```

### 7.2 Claude App（新）

```
open "claude://code/new?q=<urlencoded 短引导语>&folder=<urlencoded 绝对目录>"
```

依据：[Open Claude Desktop with a link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)

- `q`（`prompt` 是别名）预填 composer，**不发送**
- `folder` 为会话工作目录；官方把链接里的目录一律当 untrusted，**每次弹确认**，即使以前信任过
- `q` 官方大约截到 14,000 字符——这是选短引导语的原因之一
- 用 `claude://code/new`，不用 `claude://cowork/new`（交棒的是 Code session）
- 深链路径 **不写** `CLAUDE.md`

### 7.3 Codex / ChatGPT App（新）

```
open "codex://new?prompt=<urlencoded 短引导语>&path=<urlencoded 绝对目录>"
```

依据：[Codex / ChatGPT desktop commands · Deep links](https://developers.openai.com/codex/reference/commands)

- `prompt` 预填 composer，官方写明 **doesn't send automatically**
- `path` 必须是本地绝对目录，设为 active workspace
- 至少要带 `prompt` / `path` / `originUrl` 之一，否则链接无操作——我们两项都带
- 深链路径 **不写** `AGENTS.md`

### 7.4 Cursor App

官方 prompt 深链没有 folder，和打开目录是两条通道。实现按顺序走两条官方通道：

```
write AGENTS.md（短引导语，回落）
open -a / start exe <dir>
open / start "" "cursor://anysphere.cursor-deeplink/prompt?text=<urlencoded 短引导语>"
```

prompt 深链成功则 `appLaunch=deeplink`；只打开了目录则 `open-a`。不把两条通道捏成一条假协议。

### 7.5 深链失败回落

`open <deeplink>` / Windows `start "" <deeplink>` 非零：回落到现在的 `open -a` / `start exe` + 约定文件（Claude → `CLAUDE.md`，Codex → `AGENTS.md`）。回落必须在 observation / 日志里能看出来，便于真机排障。Windows 上 Codex App 走同一条 `codex://new?prompt=&path=`（`cmd /c start "" <url>`）；Cursor 仍无「目录 + 预填」协议。Claude App 未进 Windows 候选表。

### 7.6 候选表数据

在 `AgentCandidate` 上加可选字段即可，daemon 里少写 if：

```ts
/** app：有则走深链；无则 open -a + convention。 */
deeplink?: {
  /** 模板，{prompt} / {dir} 占位，插入前 URL-encode */
  template: string;
};
```

| id | deeplink.template |
|---|---|
| `claude-app` | `claude://code/new?q={prompt}&folder={dir}` |
| `codex-app` | `codex://new?prompt={prompt}&path={dir}` |
| `cursor-app` | （无，走 `open -a`） |

命令必须真机验证过才把 `deeplink` 留在表里——和现有「未验证条目不得默认启用」同一纪律。

## 8. 明确不在本轮

- **`run_local_agent`**：后端仍是 headless 形态列表，不按品牌再包一层选择。品牌开关会透过「形态 → 品牌」影响谁出现。
- **OpenCode Desktop**：桌面端已存在，但没有已验证的「打开 + 目录 + 预填」协议。继续只有 Terminal。
- **OpenCode Desktop / Pi App**：没有已验证的「打开 + 目录 + 预填」协议，继续只有 Terminal。
- **形态级开关 / 默认形态设置项 / MRU**。
- **用户自定义 agent 条目**。
- **handoff 打开真实项目目录**（仍是一次性 `~/pie-handoffs/…`；#269 spec §6 已单开）。
- **抬 `MIN_DAEMON_VERSION`**：设置合并与确认卡不依赖新 daemon；深链是新 daemon 的加法。发版时 daemon 有改动仍要 bump `daemon/package.json`（release 闸），但不为此弹全量升级卡。

## 9. 观察与文案

`HandoffResult.mode` 仍是 `"app" | "terminal"`。App 的 observation 继续成立：人必须在 App 里发一句（预填不是开跑）。可补半句「composer 已预填引导语」（仅当实际走了深链；回落 / Cursor 不要谎称预填）。实现上让 `runHandoff` 回一个加法字段即可，例如 `appLaunch?: "deeplink" | "open-a"`，旧 daemon 缺省按 `open-a`。`PROTOCOL_VERSION` 仍不动。

## 10. 交付与验收

**单 issue 单 PR。** 品牌合并、确认卡、Claude / Codex 深链是同一条用户路径，拆开会让「默认 App」先上线一截没有预填的半成品。

影响面（指引，不是任务清单）：

- `src/lib/local-agents-prefs.ts` + 测试：品牌归一化、迁移、可用谓词、toggle
- `src/sidepanel/components/settings/pages/BridgePage.tsx`：按品牌渲染
- `src/sidepanel/components/HandoffCard.tsx` + `panel-request` payload + i18n
- `src/lib/agent/loop.ts` / `tools/handoff.ts`：给卡片传品牌分组；observation 认 `appLaunch`
- `daemon/src/agents.ts` + `handoff.ts` + bun 测试：深链构造、encode、回落
- `CONTEXT.md` / ADR：品牌 vs 形态

**真机验收（need-human-test）**

1. 设置页「管理本地 Agent」按品牌一行；副行正确反映本机已装的 App / Terminal
2. 只装了 Claude Terminal、没装 Claude.app → Claude 品牌可开，确认卡无分段，交棒走 Terminal，自动开跑
3. 只装了 Claude.app → Claude 可开，确认卡无分段，走 App 深链
4. 两种都装：确认卡默认 App；切到 Terminal 再允许 → 终端自动开跑
5. Claude App：Desktop 起来，弹出目录确认，composer 里是短引导语（未自动发送）；确认目录后发送，agent 读到 `context.md`
6. Codex / ChatGPT App：以 handoff 目录为 workspace，composer 预填短引导语，未自动发送
7. Cursor App：目录作为工作区打开，`AGENTS.md` + `context.md` 在树里（不要求 composer 预填）
8. 老偏好 `["claude-app"]` 升级后 Claude 品牌为开；`["claude-terminal"]` 同样
9. 关掉某品牌 → 确认卡不再列出
10. Terminal 四家（已装的）行为与现在一致

## 附录 A：调研摘录（2026-08-15）

| 表面 | 打开 | 目录 | 预填 | 自动发送 |
|---|---|---|---|---|
| Claude Desktop | `claude://code/new` | `folder=`，每次确认 | `q=` / `prompt=` | 否 |
| Codex / ChatGPT | `codex://new` | `path=` | `prompt=` | 否（官方明文） |
| Cursor | prompt deeplink 或 `open -a` | deeplink **无** folder | `text=`（与目录脱钩） | 否，且须用户确认 |
| OpenCode Desktop | 有桌面端 | 社区在要 `opencode desktop [path]`，未进官方 CLI | 无已验证协议 | 否 |
| Pi | 无 App | — | — | — |

Terminal 继续用现有 `argv` 模板注入同一句短引导语并自动开跑。App 做不到这一条，是对方的安全设计，不是漏接 flag。
