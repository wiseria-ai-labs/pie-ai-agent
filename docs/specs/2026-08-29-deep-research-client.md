# Deep Research — 客户端 spec

> 2026-08-29。Deep Research 是 Pie Membership（Pro）独占功能，**编排与资源全部在服务端**，客户端只负责发起、查看进度、渲染报告。本文是客户端实现的背景与契约；后端设计在 `pie-managed-backend` 仓库。

## 1. 产品形态

- 侧栏新增独立「研究」视图（与 agent / settings 平级）：列表 + 详情 + 顶部发起框。
- 用户输入问题（可选"重点关注 / 排除"一句话）→ 服务端跑 5–15 分钟 → 产出带引用的 Markdown 报告。
- 完成后系统通知；点击通知跳到该报告详情。
- Composer 有「深度研究」快捷入口：跳到研究页并带上当前输入。
- 报告可「发送到对话」（塞进 composer 作草稿，不自动发送）与下载 `.md`。
- 非 Pro 用户看到的是 paywall + 内置示例报告；不提供免费试用。
- **服务端是真相源**：列表来自 `GET /research`，本地只缓存；跨设备可见的细节后续另做。

## 2. 服务端契约（v2.6，`ACCOUNT_BASE`，Bearer apiKey）

| 端点 | 请求 | 响应 / 错误 |
|---|---|---|
| `POST /research` | `{question, focus?}`，可选 `?locale=` | `201 {id}`；`403 research_requires_pro`；`429 research_quota_exceeded`；`409 research_in_progress`（每用户同时仅 1 个）；`503 research_unavailable` |
| `GET /research` | — | `{runs:[{id, question, status, createdAt, finishedAt?}]}` |
| `GET /research/:id` | — | `{id, question, status, phase?, sourcesFound, report?, references?: [{n, title, url}], error?}` |
| `POST /research/:id/cancel` | — | `{ok:true}`；**取消仍计次** |

- `status`: `queued | running | done | cancelled | failed_system`；`phase`: `plan | gather | synthesize`。
- `failed_system` = 服务端故障/超时，**不计次**，文案引导重试。
- entitlement（`GET /me/entitlement`）在 `plan:active` 时新增 `quota.research: {weekly, used, resetAt}`；`plan:none` 整字段省略。`resetAt` 与 `quota.weekly.resetAt` 同一窗口。
- 客户端不选模型、不知道搜索 provider；报告语言跟 `locale`。

## 3. 客户端分层

### 3.1 数据层（已合并，PR #64）
- `src/lib/managed-research.ts`：`startResearch / listResearch / getResearch / cancelResearch` + `ResearchError`（四个错误码）。
- `src/lib/research-poll.ts`：SW 内 `chrome.alarms`（1 分钟）轮询本地记录的进行中 run（存 IDB config store，key `research_in_progress_ids`）；done 发 `chrome.notifications`；失败/取消只移出；列表空即清 alarm。`trackResearchRun / untrackResearchRun`。
- `normalizeEntitlement` 识别可选 `quota.research`。

### 3.2 UI（待做）
- #65 研究页：列表 / 发起 / 详情（页面打开时 5s 轮询，离开停）/ 报告 + 参考文献渲染 / 剩余次数。
- #66 paywall + 内置示例报告（静态 Markdown，按 locale 选文件）。
- #67 Composer 快捷入口 + 通知点击跳详情 + 发送到对话 / 下载。

## 4. 不做（v1）
- 计划二次确认（信服务端 planner）；多轮追问（走普通 chat）；流式报告；浏览器内抓取；搜索 provider 可选；免费试用；半成品报告。

## 5. 设计原则
- 付费闸在服务端（搜索、编排、模型）；客户端的锁只是 UX，不承担防护。
- 不回收既有免费功能；DR 作为新功能直接 Pro 上线。
