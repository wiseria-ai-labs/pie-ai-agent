# Triage Labels（issue 状态机）

`wiseria-ai-labs/pie-ai-agent` 的 issue 用一套标签状态机管理任务推进。分诊 automation（本地 Orca，每小时一轮）按它归类、分级、定阶段；实现链（implementer / Reviewer automation）只在下游状态上往前走。**它是「某任务现在走到哪」的唯一事实源** —— 只看 open issue，非 open 不管。

## 标签

| 维度 | 标签 | 含义 |
| --- | --- | --- |
| 分类 | `bug` / `feature` | 缺陷 / 新功能 |
| 分级 | `P0` / `P1` / `P2` | 优先级 |
| 阶段 | `need-design` | 需要人牵头做产品化设计（设计阶段） |
| 阶段 | `need-confirm` | 方案已提出，待人拍板选项 / 取舍后进入实现 |
| 阶段 | `ready-for-implement` | 已充分指定，可交 implementer automation 实现 |
| 人工信号 | `confirmed` | 人对 `need-confirm` 拍板后打上；routine 据此补最终方案并推进 |
| 下游状态 | `agent-handling` | 已有 Loop 处理中 |
| 下游状态 | `PR` | 已提 PR，等待合入 |
| PR 复审 | `need-to-solve` | Reviewer 判定 PR 需修改，交回 implementer |
| PR 复审 | `solved` | implementer 已按意见改完，等 Reviewer 复审 |
| PR 复审 | `need-human-test` | 通过 code review，需真机验收 |
| PR 复审 | `human-approved` | 真机验收通过，可直接合并（人打，或验收 automation / `skip-human-test` 放行） |
| PR 复审 | `auto-accepted` | 自动化真机验收通过，待人工抽查报告盲区 |
| 人工信号 | `skip-human-test` | 人显式跳过真机验收；复审通过后可直接合 |

## 状态机

```
新 issue ─分诊─► 分类(bug/feature) + 分级(P0/P1/P2) + 阶段
                              │
        ┌─────────────────────┼─────────────────────┐
   need-design           need-confirm          ready-for-implement
   (待人设计)        (人打 confirmed 拍板)            │
                          │ routine 读 confirmed     │
                          │ 补方案、去 need-confirm   │
                          └──────────────────────────┤
                                                      ▼
                                          agent-handling ─► PR ─► (见下 · PR 复审)
```

## PR 复审与合并（Step3 / Step4）

implementer 提 PR 后，**Step3 复审**（每小时 :50）先按 `/code-review` skill 卡代码质量，再分诊是否要真机；**Step4 真机验收**（每小时 :55，接在复审之后）接 `need-human-test`：

```
PR 提出 ─► Step3 复审（/code-review + 设计符合 + 单测 + 跑 gate）
            ├─ 需要修改              → need-to-solve ─► implementer 修复 ─► solved ─► 复审 ↺
            ├─ 过·需真机             → need-human-test ─► Step4 验收
            │                              ├─ FAIL 回归     → need-to-solve（回到 implementer）
            │                              ├─ PASS + 须人工 → auto-accepted（等人抽查盲区后打 human-approved）
            │                              ├─ PASS 且免人工 → human-approved ─► 复审下轮合并
            │                              └─ skip-human-test / 空队列 → 跳过（precheck 不启 worktree）
            ├─ 过·带 skip-human-test → 复审直接合并
            └─ 过·无需真机           → 复审直接合并 main（仅纯文档/注释/测试/CI，或纯内部重构且单测足够）
```

- Reviewer 与 implementer 是**同一个 GitHub 身份**（`wenkang-xie`，org owner），GitHub 禁止自审自批，故 review 意见走普通评论、**状态机靠标签驱动**（不靠 GitHub 原生 review 状态）；main 分支保护已放宽为「需 PR、0 approve」，该身份遂可直接合并（squash）。详见下「本地执行环境」。
- `need-to-solve` 的 PR 由 **implementer automation（Step2）优先接走**（先收尾在途 PR，再实现新 issue），不单设 PR Solver。
- `human-approved` 可由人打，也可由验收 automation 在「全 PASS 且无人工盲区」或看到 `skip-human-test` 时打；复审见到即合并。
- 自动合并走**保守白名单**：仅纯文档 / 注释 / 纯测试 / CI 配置、或纯内部重构且单测充分才直接合；碰 `src/**` 运行时代码一律 `need-human-test`（除非人打了 `skip-human-test`）。
- 复审必须先读并执行 `~/.grok/bundled/skills/code-review/SKILL.md`；Approval Bar 未过不得放行。

约定：
- **「未分诊」** = open 且无任何阶段标签、无 `confirmed`、无下游状态标签。
- `need-confirm` **只认显式 `confirmed`** 才推进（不靠机器猜评论是否算确认，防误判提前放行）。
- 下游状态（`agent-handling` / `PR`）由实现链产出，分诊**只识别、跳过、绝不回退**。
- 标签由人预建（见下「本地执行环境」）；automation 只使用、不创建。

## 改规则 / 排查

整条流水线由 4 条**本地 Orca automation** 串成（2026-08-14 起；此前跑在 claude.ai 云端 routine，现已全部停用但保留，随时可回滚）。逻辑写在各自的 prompt 里（不是本仓库代码），默认 agent = **grok**，每次 run 新建 Orca worktree、跑完即弃。同一小时内顺序是 **:10 分诊 → :28 实现 → :50 复审 → :55 验收**，空队列靠 `precheck` 直接 skip，不启 worktree。另有一条家政 automation 每小时 :00 清掉已结束的 loop worktree（挂在 main 上跑，自己不新建卡片）。

改规则 = `orca automations edit <id> --prompt "$(cat 新 prompt)"`；查 = `orca automations list` / `show <id>` / `runs <id>`；手动跑一轮 = `orca automations run <id>`；删 = `orca automations remove <id>`。

| Step | automation id | cron（Asia/Shanghai） | 职责 |
| --- | --- | --- | --- |
| Step1 分诊 | `0ad1d1c2-01bc-4c6b-ab0a-a839e83f4cb3` | `10 * * * *` | issue 分诊（归类/分级/定阶段）+ 消费人工 `confirmed`+`need-confirm` → 补方案 → `ready-for-implement` |
| Step2 实现 | `5184e55f-1ae5-4b7d-b71f-e31bdeb90504` | `28 * * * *` | implementer：优先修 `need-to-solve` PR，其次实现 `ready-for-implement` issue → 提 PR |
| Step3 复审 | `57c79037-ba9c-401d-9a6f-1f8acf8f8bef` | `50 * * * *` | PR Reviewer：`/code-review` + 合并 |
| Step4 验收 | `49fc699e-317c-4f09-a900-81d6c1adb9e1` | `55 * * * *` | 真机验收（`need-human-test`）；无候选 / `skip-human-test` / 已 `auto-accepted` 同 SHA 则跳过 |
| 清理 | `900194b4-a04e-4ecb-a37f-f5d7c195100a` | `0 * * * *` | 删掉已结束的 loop worktree（`【pie】Step*` / `auto-pie-*` / `auto-pr-run-*`）；main、pin、人手 issue 卡、60 分钟内还在活动或有 live terminal 的不删。脚本：`scripts/cleanup-orca-loop-worktrees.py` |

## 本地执行环境

automation 跑在本机 Orca worktree 里，`gh` CLI 可用、默认账号 `wenkang-xie` 就是 org owner，GitHub 操作一律走 `gh`（不再有云端「无 gh，全走 github MCP」那套约束）。仍然成立的硬约束：

- **不创建标签**：所有标签人工预建好，automation 只用不建（避免误建同义标签把状态机搞脏）。
- **单一身份 `wenkang-xie`（org owner）**：同一身份不能自审自批自家 PR，故 review 走普通评论 + 标签驱动，不用 `gh pr review`。
- **main 分支保护已放宽** `required_approving_review_count` → 0（保留「需 PR」、`enforce_admins=false`），该身份可 `gh pr merge --squash --admin` 合自己的 PR。
- 本地能真跑 gate（`pnpm test` / `typecheck` / `build`），Reviewer 的「跑绿了才合」是实打实的。
- **仓库只认 `wiseria-ai-labs/pie-ai-agent`**：所有 `gh` 必须带 `-R wiseria-ai-labs/pie-ai-agent`。禁止 `gh auth switch`，禁止切到 `WiseriaAI` / `wiseriai`（keyring 里这两个账号 token 已失效；旧 org 仓库已 404）。
- **认领要回读**：implementer 把 issue 改成 `agent-handling` 后必须立刻 `gh issue view` 确认抢到锁；已有 open PR 的 issue 只改标签、不另开分支。
- **`confirmed` 只在仍带 `need-confirm` 时推进**：已经是 `ready-for-implement` 的只摘残留 `confirmed`，不再重写方案评论。
