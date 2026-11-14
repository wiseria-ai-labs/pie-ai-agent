# Triage Labels → Kumo 阶段

`wiseria-ai-labs/pie-ai-agent` 的任务推进已从 GitHub 标签状态机迁到 **Kumo agentflow + Task stage**（2026-11-14 起）。**任务现在走到哪，唯一事实源是 Kumo Task 的 stage**；GitHub 标签只保留给人看的分类与分级。

## 现行状态机

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 阶段 | Kumo Task `stage` | `new` / `planning` / `confirming` / `ready` / `in_progress` / `in_review` / `done` |
| 分诊 | Kumo flow **`pie-triage`** | 新 issue 入册成 Task（事件 `task.created`）时触发：写「## 分诊」任务书、打分类/分级标签、定阶段 |
| 实现链 | Kumo flow **`workflow`**（Pie dev loop） | Task 拨到 `ready` 时触发；implement → review → acceptance → merge，异常进 escalate |
| 分类 / 分级 | GitHub 标签 `bug`/`feature`、`P0`/`P1`/`P2` | 只给人看，不驱动流转 |

```
新 issue → Task(new) → pie-triage ─┬─ ready ──────────→ dev loop → PR → merge → Task(done)
                                   ├─ confirming ─→ 人拍板 → 手动拨 ready
                                   └─ planning ───→ 人补方案 → 手动拨 ready
```

流程与提示词用 `"$KUMO_BIN" flow get workflow` / `flow get pie-triage` 查看；改流程 = 改 flow 定义（整份 JSON 写回），不再改 automation prompt。

## 人工闸只剩两处

1. 分诊判 `confirming` / `planning` 的 issue：人在 Kumo Tasks 页裁决后把阶段拨到 `ready`。
2. dev loop 的 `escalate` 节点：回边次数用尽、方案被判定做不下去、或验收环境故障时，节点贴交接评论并把阶段拨回 `confirming`，等人处理。

PR 本身没有人工验收标签了：Review 判断要不要真机，Acceptance 自己下结论（`pass` / `fail` / `blocked`），自动化覆盖不到的项进「留发版冒烟」，由 tag 前的 `pnpm smoke:release` 兜。详见 `docs/agents/auto-acceptance.md`。

## 历史标签（旧 Orca 状态机残留）

老 issue / PR 上还能看到这些，**新流程不再打、也不再消费**，看到可以直接忽略：

| 旧标签 | 旧含义 |
| --- | --- |
| `need-design` | 待人牵头产品化设计 |
| `need-confirm` / `confirmed` | 待人拍板 / 人已拍板 |
| `ready-for-implement` | 可交 implementer |
| `agent-handling` / `PR` | 实现中 / 已提 PR |
| `need-to-solve` / `solved` | PR 需改 / 改完待复审 |
| `need-human-test` / `auto-accepted` / `human-approved` / `skip-human-test` | 旧的人工真机验收流转 |

## 仍然成立的硬约束

- **仓库只认 `wiseria-ai-labs/pie-ai-agent`**：所有 `gh` 必须带 `-R wiseria-ai-labs/pie-ai-agent`。禁止 `gh auth switch`。
- **不创建标签**：`bug` / `feature` / `P0` / `P1` / `P2` 已人工预建，automation 只用不建。
- **单一身份 `wenkang-xie`（org owner）**：同一身份不能自审自批，review 意见走普通 PR 评论，不用 `gh pr review`。
- **main 分支保护**：经典保护 `required_approving_review_count = 0`（保留「需 PR」）；另有 ruleset「main: extension 必过 + 合并前必须与 main 同步」（`strict_required_status_checks_policy=true`，必需检查 `extension`，**bypass 名单为空 → 连 admin 也绕不过**）。合并一律用 `gh pr merge --squash --delete-branch`；**不要加 `--admin`**（`strict` 闸会照样拒，报 `Repository rule violations found`）。PR 落后 main 时先 `gh pr update-branch` 再等新一轮 CI —— `gh run rerun` 复用的还是旧 merge commit，测不到新 main（2026-11-14 #485 就是这样带着断掉的测试进了 main）。
- 本地能真跑 gate（`pnpm test` / `typecheck` / `build`），绿了才可合。
