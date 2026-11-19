# Pie 账号独立 + 邮箱验证码登录

> 状态：设计稿（待拍板 §6）。跨仓库：扩展（本仓库）+ `pie-managed-backend/account`。契约 v2.11 → **v2.12**。

## 1. 现状（为什么要动）

- **账号 = 一条 `provider:"managed"` 的 instance**。apiKey（LiteLLM 长效 virtual key）存在 instance 里，nickname = email。全仓库 8 处各自 `listInstances().find(i => i.provider === "managed")` 取 key（memory / research / feedback / ErrorCta / ReportProblem / research-poll / App / FeedbackPage）。
- **登录不落盘**：`ManagedSubscribePanel` 拿到 `{apiKey, entitlement}` 只放组件 state，**订阅 active 后**才 `onCreate("managed", …)` 建 instance。登录了但没订阅 = 扩展里没有账号，关面板即丢。
- 入口全在「模型」：设置 → 模型 → 新建配置向导「官方」tab / instance 展开区的 `ManagedAccountPanel`。所有订阅 CTA（Memory paywall、Research、官网 deeplink）都是 `openSettings("models") + subscribeNonce`。
- 后端 `pie_users` 以 `google_sub TEXT UNIQUE NOT NULL` 为身份主键，email 无约束；`litellm_user_id = google:${sub}`，`recreateKey` 的 alias 用 `pie-${googleSub}`。`decodeIdToken` 不读 `email_verified`。

## 2. 目标

1. 账号从模型配置里抽出：设置页独立「账号」入口，承载登录 / 退出 / 订阅 / 账单 / 兑换码 / 额度。
2. 新增邮箱验证码登录（未注册自动注册），与 Google 登录按邮箱打通：同一邮箱两种方式进来是同一个账号。

非目标：多账号并存、密码登录、magic link、手机号。

## 3. 扩展侧设计

### 3.1 数据：不迁移，换个说法

**managed instance 继续是账号的唯一存储**（一台设备至多一条，已有约束）。不新增 `pie_account` 记录——那会让同一把 key 有两个真源。改的只是：

- 新增 `src/lib/pie-account.ts`：`getPieAccount(): Promise<{ instanceId, apiKey, email } | null>`，替换上述 8 处重复的 `find`（净删代码）。
- **登录即落盘**：`/auth/exchange` 或 `/auth/email/verify` 成功 → 立刻建 managed instance（不再等 plan active）。存量用户已有 instance → 自动视为已登录，零迁移。
- **退出登录** = 删 managed instance + 清 `managed_entitlement_<key>` + **清本地记忆**。绑定该 instanceId 的会话走现有「instance 被删」兜底。
  - 记忆：清掉本地 memory store 全部内容（条目 / profile / state / 待上传 digest 队列 / 同步 revision），使「退 A 登 B」不会把 A 的记忆推进 B 的云端，B 登录后从云端重新拉。**只清本地，不调云端 `/memory/clear`**（云端是账号的数据，退出不等于删除）。实现时核对 `src/lib/memory/store.ts` 的 `clearAllMemory` 是否会连带触发云端清空，会的话另写本地专用清理。
  - **会话历史不清**（已拍板，暂时保留）。

### 3.2 UI

- **设置根页顶部加账号卡**（在「基础」分组上方，独立一行，类似系统设置的 Apple ID 卡）：
  - 未登录：「登录 Pie 账号」+ 一行副文案（解锁官方模型 / 记忆同步 / Deep Research）。
  - 已登录：email + 状态徽标（Pro / 未订阅 / 付款失败）。
  - 点击 → 新二级页 `account`（`SettingsPage` 加 `"account"`）。
- **`AccountPage`**（新文件 `settings/pages/AccountPage.tsx`，复用现有组件，不重写）：
  - 未登录 → `PieLoginForm`（§3.3）。
  - 已登录 → 现有 `ManagedAccountPanel`（plan none 时它已内嵌 `ManagedSubscribePanel` 订阅引导；active/blocked 显示套餐、续费日、额度、管理账单、兑换码）+ 底部「退出登录」。
- **模型页**：managed instance 不再出现在配置列表里，配置计数徽标也不计它。新建配置向导删掉「官方」tab（向导回归纯 BYOK）。首启引导里需要「用官方」时，直接跳 `account`。
- **ModelPicker / overlay 模型选择**：managed 分组只在缓存 `plan === "active"` 时出现。未订阅时不显示（不再回落 registry 单条兜底，避免选中后必然 401）。
- **CTA 重定向**：所有 `openSettings("models") + subscribeNonce` 改为 `openSettings("account")`；`DEEPLINK_MANAGED_SUBSCRIBE` 同样落到 `account`。`subscribeNonce` / `managedEntryNonce` 删除。

### 3.3 登录表单 `PieLoginForm`

从 `ManagedSubscribePanel` 第一屏抽出来（订阅屏保持不动），两种方式同屏：

```
[ G  使用 Google 继续 ]
──────── 或 ────────
[ 邮箱地址            ]
[ 发送验证码 ]
        ↓ 发送成功
验证码已发送至 a@b.com  · 换邮箱
[ _ _ _ _ _ _ ]        ← 6 位，inputmode=numeric，autocomplete=one-time-code，满 6 位自动提交
重新发送（59s）
```

- 本地只做格式校验（`<input type="email">` 原生校验即可），canonical 化归后端。
- 错误文案按后端 code 映射：`invalid_email` / `invalid_code` / `code_expired` / `too_many_attempts`（带 `retryAfter` 秒数）。
- 成功后走与 Google 同一路径：`cacheEntitlement` → 建 instance → 进 `ManagedAccountPanel`。
- 新增 `src/lib/managed-auth.ts` 两个函数 `sendEmailCode(email)` / `verifyEmailCode(email, code)`，返回值与 `startManagedLogin` 同型 `LoginResult`。

## 4. 后端设计（`pie-managed-backend/account`）

### 4.1 身份模型

身份 = **规范化邮箱**；Google sub 降为可选的附加绑定。

```sql
ALTER TABLE pie_users ALTER COLUMN google_sub DROP NOT NULL;           -- UNIQUE 保留（NULL 可多条）
ALTER TABLE pie_users ADD COLUMN IF NOT EXISTS email_canonical TEXT UNIQUE;
-- 回填：email_canonical = canonical(email)；撞重的后来者留 NULL 并打日志，admin 人工处理
```

`canonicalEmail(e)` = **仅 trim + 全小写**（已拍板：不做 Gmail 去点 / 去 `+` 等规则化，`a.b@gmail.com` 与 `ab@gmail.com` 视为两个账号，接受这个口子）。

`pie_users.email` 保留首次注册时的原样写法用于显示 / Stripe customer。

### 4.2 登录时的账号解析（两条路共用一个函数）

```
resolveUser({ emailCanonical, emailRaw, googleSub? }):
  if googleSub: u = findByGoogleSub(sub); if u → return u        # 老用户 / 已绑定
  u = findByEmailCanonical(emailCanonical)
  if u:
     if googleSub && !u.googleSub → attachGoogleSub(u.id, sub)    # 邮箱账号首次用 Google 登录 = 自动绑定
     return u
  return insertUser(...)                                          # 自动注册
```

- **Google 路径**：仅当 id_token 的 `email_verified === true` 才参与按邮箱匹配；否则只按 sub 查，查不到就新建且 `email_canonical` 置 NULL（不占邮箱，避免未验证邮箱抢占他人账号）。`decodeIdToken` 加读 `email_verified`。
- **OTP 路径**：验证码本身证明了邮箱所有权，直接 `resolveUser({ emailCanonical, emailRaw })`。
- 两个方向都安全：合并的前提是双方都证明了对同一邮箱的控制权。
- 并发注册同一邮箱：靠 `email_canonical UNIQUE`，insert 撞 23505 → 重查返回（与现有幂等语义一致）。
- 新用户 `litellm_user_id = pie:${randomUUID()}`（不再依赖 google sub）；`recreateKey` 的 alias 改为 `pie-u${user.id}`。存量 `google:${sub}` 不动。
- Google 账号改了邮箱：按 sub 命中老用户，**不**自动改 email / email_canonical（v1 不处理，有反馈再加）。

### 4.3 验证码

表：

```sql
CREATE TABLE IF NOT EXISTS pie_email_otps (
  email_canonical TEXT PRIMARY KEY,   -- 每邮箱同时只有一个有效码，新发即覆盖旧码
  code_hash TEXT NOT NULL,            -- HMAC-SHA256(OTP_SECRET, email_canonical || code)，不存明文
  expires_at BIGINT NOT NULL,         -- 发出后 10 分钟
  attempts INT NOT NULL DEFAULT 0,    -- 校验失败计数，满 5 次作废
  last_sent_at BIGINT NOT NULL,
  sent_today INT NOT NULL DEFAULT 0,
  sent_day TEXT NOT NULL              -- UTC 日期，换日清零 sent_today
);
```

- 码：6 位数字，`crypto.randomInt(0, 1e6)` 补零；校验用 `timingSafeEqual`；成功即删行（单次使用）。
- 限流：
  - 同邮箱：发送间隔 ≥ 60s，每日 ≤ 10 封（从表里算，跨重启有效）；
  - 同 IP：发送 ≤ 20 次/小时、校验 ≤ 30 次/小时（复用 `ratelimit.ts` 的 `AttemptLimiter`，进程内，ceiling 同现有注释）。
- **不泄露是否已注册**：`/auth/email/start` 对新老邮箱响应一致。
- 发信：Brevo transactional API（已有账号，PH 发码在用），一次 `fetch`，不引 SDK。模板按 `?locale=` 选 en / zh-Hans（其余回落 en）。主题形如「Pie 验证码：123456」，正文写明 10 分钟有效、非本人操作可忽略。发件域 `pie.chat` 需配好 SPF / DKIM / DMARC。
- 新 env：`BREVO_API_KEY`、`OTP_SECRET`、`MAIL_FROM`。
- **本地/验收模式**：`BREVO_API_KEY` 未配时不发信，改为把验证码打到 stdout（`[otp-dev] <email> <code>`）并在启动时 warn 一次，供 docker 本地与自动化验收读取。`OTP_SECRET` 未配时回退已有服务端 secret（与 `MEMORY_ENCRYPTION_KEY` 回退写法一致）。部署手册注明生产必须配 `BREVO_API_KEY`。

### 4.4 契约 v2.12（新增两个端点，其余不变）

| 端点 | 方法 | 请求 | 成功 | 错误 |
|---|---|---|---|---|
| `/auth/email/start` | POST | `{email}`（可选 `?locale=`） | `{ok:true}` | `400 invalid_email` / `429 too_many_attempts {retryAfter}` / `502 mail_send_failed` |
| `/auth/email/verify` | POST | `{email, code}`（可选 `?locale=`） | `{apiKey, entitlement}`（与 `/auth/exchange` 同形） | `400 invalid_code` / `400 code_expired` / `429 too_many_attempts` |

- `apiKey` 语义不变：同一账号无论哪种方式登录都拿到同一把长效 key（多设备共享，与现状一致）。
- `/auth/exchange` 外部行为不变，内部改走 `resolveUser`。

## 5. 风险

- **一次性邮箱 / 邮箱别名刷首月半价**：已接受（不做规则化）。plan none 没有任何模型权益，损失只在 intro offer；出现滥用再处理。
- **邮件轰炸**：靠 §4.3 限流兜。被刷时再前置 Turnstile。
- **回填撞重**：迁移前先跑 `SELECT lower(trim(email)), count(*) … HAVING count(*) > 1` 看数据，预期为 0。回填只能写成「`WHERE email_canonical IS NULL` 的幂等 UPDATE」并评估是否违反后端 CLAUDE.md「migrate() 禁止会重跑的回填」——该条针对的是会覆盖已有值的回填；若仍有疑虑，改为一次性脚本 `scripts/` + deploy.md 记录。
- **账号切换的记忆串号**：见 §3.1，退出登录清本地记忆。

## 6. 已拍板

1. 发信服务：Brevo transactional API。
2. 邮箱只 trim + 小写，不做 Gmail 规则化。
3. 未订阅时 ModelPicker 里不显示官方分组。
4. 新建配置向导删掉「官方」tab，入口统一到账号页。
5. 退出登录清本地记忆，不清会话历史、不清云端记忆。

## 7. 切片（tracer bullet，可并行）

| # | 仓库 | 内容 | 依赖 |
|---|---|---|---|
| B1 | backend | `email_canonical` 迁移+回填、`resolveUser`、Google 路径改走它（含 `email_verified`）、`litellm_user_id`/alias 去 sub 化 | — |
| B2 | backend | `pie_email_otps` + 两个端点 + Brevo 发信 + 限流 + contract v2.12 | B1 |
| C1 | 扩展 | `getPieAccount` 收口 8 处、登录即落盘、退出登录（含记忆镜像清理）、设置根页账号卡 + `AccountPage`、模型页/向导移除 managed、CTA/deeplink 改指 `account`、ModelPicker 按 plan 过滤 | — |
| C2 | 扩展 | `PieLoginForm` 邮箱验证码 UI + `sendEmailCode`/`verifyEmailCode` | B2（staging）、C1 |

验收要点：
- 同一 Gmail 先 Google 后 OTP、先 OTP 后 Google，都拿到同一 `apiKey`、同一订阅；大小写不同（`Foo@Gmail.com`）视为同一账号。
- 未注册邮箱 OTP → 自动建号，`plan:none`，扩展里已登录、可走订阅。
- 存量 Google 用户升级后无感：仍是已登录，模型与订阅不变。
- 退出登录 → 模型选择里官方分组消失、记忆回 locked、本地云记忆镜像已清。
