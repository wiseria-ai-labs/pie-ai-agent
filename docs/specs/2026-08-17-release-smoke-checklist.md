# 发版真机冒烟清单

Date: 2026-08-17
Status: Frozen v1（套件 `eval/acceptance/release-smoke/`；发现新回归再往清单加）
Slug: release-smoke-checklist

> 目的：打 tag 之前，用一套**固定**的真机闭环证明 Pie 的基础功能没被近期合入冲坏。
> 不是 WebArena 效果评测，也不是某个功能 PR 的 `need-human-test` 清单。
> 基础设施复用 `eval/acceptance`（Playwright + `dist-eval` / `dist` + scratch daemon），配方坑见 `docs/agents/auto-acceptance.md`。

---

## 0. 闸怎么用

| 批次 | 代码 | 跑法 | 失败怎么挡 |
|---|---|---|---|
| 功能批 | **F** | Playwright 直驱 UI，无 LLM | 任一条 FAIL/ERROR → **硬挡**，不能签字发版 |
| 生产包批 | **P** | 只加载 `pnpm build` 的 `dist/`，无 `__pieEval` | 同 F，硬挡 |
| LLM 批 | **L** | 真 composer + 一家钉死的冒烟模型 | 失败重试 1 次；仍红则人看 `getTrace`：工具/UI 坏了 → 挡；模型没听话 → 不挡，报告里写明 |
| 人工盲区 | **H** | 真 Chrome 侧栏抽查 | 不得标 PASS；签字前必须扫一眼 |

整包目标 **≤ 20 分钟**。超出就砍条，不要加机器。

默认环境：

- locale 钉死 `en-US`（文本断言走 `data-testid` / role，不靠文案）
- 冒烟模型：`~/.pie/acceptance.env` 里现有的 `PIE_EVAL_PROVIDER/MODEL/API_KEY`，不另换
- F/L 主跑 `dist-eval`（可 SW RPC / 必要时 seed）；P 另起 profile 加载 `dist/`
- scratch HOME + 短 `PIE_ACCEPT_BASE`；F24 需要 scratch daemon
- sidepanel 以 tab 打开，viewport 420×900（排版手感归 H01）

结论行只有两种（沿用 auto-acceptance）：

- 「冒烟通过，建议抽查 H 区后打 tag」
- 「存在硬挡 FAIL，不能打 tag」

---

## 1. F — 功能批（无 LLM，硬挡）

### 1.1 空配置冷启动

| ID | 做什么 | 证据 | 备注 |
|---|---|---|---|
| F01 | 全新 profile、零 instance。Chat 空态：无 composer，有「Open Settings」CTA | DOM：CTA 存在；composer textarea 不存在 | `hasConfig === false` 分支 |
| F02 | 点 CTA → 进入 Settings root | `data-testid="settings-row-models"` 出现 | 齿轮按钮文案会跟 chat CTA 撞名，点 CTA 本身，别用模糊 aria |

### 1.2 Settings 骨架

每个 drill-down 打开后必须能看见该页特征节点，点 TopBar back 回到 root。白屏 / 抛错 / back 失效 = FAIL。

| ID | 做什么 | 证据 |
|---|---|---|
| F03 | 打开并返回：`models` / `bridge` / `search` / `uiLanguage` / `assistantLanguage` / `customRules` / `feedback` / `about` | 各页特征节点 + 回到 `settings-row-models`。不要写死「共 N 行」——root 测试里那份 7 行清单已经漏了 `customRules` |
| F04 | Theme：`theme-dark` → `documentElement.dataset.theme === "dark"`；`theme-light` → `"light"`；同 profile 重载后仍在 | DOM `aria-pressed` + `dataset.theme` + 重载后仍在。全程不离开设置页再回来「碰巧对」 |
| F05 | CDP 开关拨开 / 拨关 | 双流：DOM `cdp-switch` 与 `isCdpInputEnabled()` 跟随延迟 ≤ 一轮轮询。clean 旧版若断言永远绿，说明没测到跟随 |
| F06 | Panel-window 开关拨一次 | DOM `panel-window-switch` 与 IDB `panel-mode` 一致。不验真窗口形态（那是 Chrome 壳，H 区） |

语言页只打开、列出选项，**不切换 locale**（后面整套断言会跟着炸）。

### 1.3 BYOK：存、切、改、删、活过重启

钉死一家 builtin（与 `acceptance.env` 同一家）。同一把 key 建两个 nickname 即可，不必第二家。

| ID | 做什么 | 证据 |
|---|---|---|
| F07 | Models → 新建 BYOK：选 provider → nickname + key → 保存 | IDB `instances` 多一条；`instances_index` 长度 +1；root `settings-badge-models` 跟随；回到 Chat 后 composer 出现（textarea 存在） |
| F08 | 对该 instance 点 Test connection | UI 必须打出结果（ok 或错误条）。有活 key 时期望 ok；401/额度记 **ERROR（环境）** 不挡发版，UI 没反应才是 FAIL |
| F09 | 再建第二条 instance（**另一家** builtin + dummy key）。wizard 和 `createInstance` 都是一 provider 一条，同 provider 第二条会直接拒 | 列表 2 条；composer instance chip 能切到第二条；`last_model_selection` 跟着变（双流，不 reload） |
| F10 | 展开第一条，改 RPM 上限，保存，收起再展开 | RPM 输入回显刚写的值。当前 UI 没有 nickname 编辑框，改名不在 v1 |
| F11 | Replace key：走替换流程写入新密文 | IDB 里该 instance 能解密；UI 仍是部分掩码，不回显全文 |
| F12 | 删掉非 active 的那条 | 列表 −1；active 仍是留下的那条；composer 仍可用 |
| F13 | 新建一条 custom provider：name + `baseUrl` + 一个 model id + key → 保存 | 实体进 custom provider store；再打开编辑卡：`baseUrl` 在 provider 上，instance 卡没有 override 输入 |
| F14 | 关掉 browser context，同一 `user-data-dir` 再启动 | `listInstances()` 仍在；Chat 不是 F01 空态；nickname 还在。这是 AES-GCM + IDB 的真机项，单测替代不了 |

F07 必须走 **wizard 真点击**，不要 `seedConfig` 偷过——seed 测不到保存路径。F14 才是「存盘活过重启」。

### 1.4 Session

Drawer 故意藏「空的 active session」。所以先要有一条带消息的 session。F 批评 LLM：直接往 IDB 写一条带 `messageCount ≥ 1` 的 session（或走已有 session API），再测 UI。

| ID | 做什么 | 证据 |
|---|---|---|
| F15 | TopBar `topbar-new`：新 session，Chat 空 | 当前 sessionId 变了；composer 空；**drawer 里还看不到这条**（空 active 隐藏是设计，别当回归） |
| F16 | 两条带消息的 session：打开 drawer，点另一条 | 高亮 + Chat 内容切到对应 session；双流，不靠重挂载 |
| F17 | 归档一条 → 展开 archived → unarchive | active 列表消失 / 出现；IDB status 跟随 |
| F18 | 对 archived 再 hard-delete | index 里没了；Chat 不会停在已删 id |

### 1.5 其它一级入口 + 一条可写偏好

| ID | 做什么 | 证据 |
|---|---|---|
| F19 | `topbar-skills` → SkillsList | 页挂载。daemon-off 下列表没有 builtin 是设计 |
| F20 | `topbar-schedules` → SchedulesPanel | 页挂载（空态即可），back 回 Chat |
| F21 | Drawer `drawer-settings` → Settings root | `settings-row-models` 出现 |
| F22 | Custom rules：写入一行 → 保存 → 同 profile 重载 | IDB 里还在，页上回显。这是「设置能写进去」的代表项，不测规则是否进 prompt |
| F23 | composer 有配置时：空输入 Send 不可点；instance chip 看得到；tools/attach 菜单能开能关 | 纯 DOM。不点 Recording（那是另一条产品路径） |

### 1.6 桥状态跟随（要 scratch daemon）

| ID | 做什么 | 证据 |
|---|---|---|
| F24 | 设置根页 bridge badge 跟随 SW 真值 | 复用 `pilot-299-functional.mjs` 的双流采样：`bridge.ready` 与 badge 文本延迟 ≤ 一轮。同脚本在「daemon 未起」profile 上必须看到 Off，不能两头都绿 |

F24 进默认配方。daemon 没起来是 ERROR（环境），不是 SKIP 当过。

---

## 2. P — 生产包（硬挡）

`__pieEval` 只存在于 `dist-eval`。用户拿到的是 `dist/`。`pnpm verify:no-eval-bridge` 只能证明 bridge 没漏进包，证明不了没 bridge 时 panel 还能走完配置。

| ID | 做什么 | 证据 |
|---|---|---|
| P01 | `pnpm build` 的 `dist/`，全新 profile。SW 上 `typeof __pieEval === "undefined"`。走 F01→F02→打开 models | 无 bridge；空态 CTA 能进设置 |
| P02 | 在这个 prod profile 上再走一遍 F07（wizard 存 key → composer 解锁） | 同 F07。**禁止** seedConfig |

P 不跑 LLM、不跑 session 全家桶。F 批已覆盖深度，P 只锁「发版包自己能配上」。

---

## 3. L — LLM 批（软挡 + 1 次重试）

全部走 **真 composer Send**，禁止只调 `__pieEval.startTask` 当主路径。`__pieEval.getTrace` 可作辅证，但 session 必须是 composer 建出来的那条。

本地 fixture：harness 起一个静态页，例如 `h1#smoke-heading` = `SMOKE-HEADING`，`button#smoke-target` 点击后 `data-smoked="1"`。不要 WebArena，不要外网站点。

钉死一家模型。Prompt 写死，改 prompt 必须改断言说明。

| ID | 做什么 | 证据 | 挡发版？ |
|---|---|---|---|
| L01 | composer 发「Reply with the single word PONG and nothing else.」 | `role=status` 工作指示出现过；结束后有一条非空 assistant。**不要**把「必须等于 PONG」当硬断言 | 无工作指示 / 无 assistant 回合 → 挡。只有用词不对 → 不挡 |
| L02 | 发一条会跑几步的任务，出现 working 后点 Stop | streaming 停；session 不卡在 running；可再输入 | 停不下来 / composer 锁死 → 挡 |
| L03 | fixture 已打开。发：「Read the page. Click the button with id smoke-target. Then call done.» | 磁盘/DOM：`#smoke-target[data-smoked="1"]`。trace：有 `read_page`、有 `click`、有 `done`。`read_page` observation 带 `<untrusted_page_content>` | DOM 没变或根本没调工具 → 挡。多调了无关工具不挡 |
| L04 | L03 结束后同一 session 再发：「What was the heading you just read?」 | 第二条 user 进了同一 session；模型不必答对，但请求必须带上一段历史（trace / 发出的 messages 里有上一轮） | 第二轮当新会话 / 只有一条 user → 挡 |
| L05 | L03 期间或之后，TopBar pin 行显示 fixture origin | `topbar-pin-row` 文本含 fixture host | pin 行完全不出现 → 挡（页面操作后用户看不见钉了哪个 tab） |

L 批禁止只断言对话文本。L01 的 PONG 是烟雾弹，真正锁的是「loop 跑起来且 UI 跟得上」。

L03 是整份清单里唯一一条同时锁 **agent loop + 读工具 + 写工具 + 页面副作用** 的项。fixture 挂了或选择器漂了先修 fixture，别放宽成「看 agent 有没有努力」。

---

## 4. H — 人工盲区（不得标 PASS）

签字前用人在**品牌 Chrome**里扫。自动化报告必须把本区列出来。

| ID | 看什么 | 为什么机器不行 |
|---|---|---|
| H01 | 真 side panel（不是 tab）打开 Chat + Settings，看一圈有没有裁切、空心、叠层 | tab ≈ panel，排版不是一回事 |
| H02 | 本机已装的扩展，点一次 Pie Link / optional 权限。只看「开关还在、弹框还是浏览器的」 | Playwright 点不了浏览器级弹框；harness 还把 `nativeMessaging` 提成必选 |
| H03 | 若本发版动过 PDF / file://：用一个本地 PDF 看权限卡是否还冒得出 | file URL 授权在浏览器设置里 |
| H04 | 若本发版动过 HITL（skill-grant / CDP 黄条 / 文件访问卡）：人手走一张卡 | headed 才能点；默认套件为了时间不跑 |

不进 H、也不进套件：Windows / Edge、托管订阅支付、OAuth、全 provider 真打、WebArena、录制变 skill、截图/多模态、skill 脚本、定时任务跑通。这些是功能 PR 自己的 `need-human-test`，或下一次加码。

---

## 5. 刻意不做

- WebArena 812 题、`run-batch.sh`、HAR scorer——测的是模型效果，健康产品也会红。
- 按 PR 再复制一份 `pilot-<n>-*.mjs`。发版套件只有一份，活在 `eval/acceptance/release-smoke/`。
- 「每个按钮点一遍」。Settings 子页只要求挂载+返回；可写路径只抽 BYOK、session、custom rules、CDP/theme。
- 套件中途切 UI 语言。
- 把 L 批挂进 GitHub Actions，或挡日常功能 PR 的 CI。

---

## 6. 报告里最少要有

环境：Chromium 版本、`dist` vs `dist-eval`、daemon 是否起来、模型三元组（不要打印 key）。

表：每个 ID 一行，`PASS / FAIL / ERROR / SKIP`，FAIL/ERROR 附现场值或截图名。H 区单独「留人工」，状态只能是未覆盖。

另外强制写：

- Fixture：L03 用的本地页 URL；技能数（F19 若只有空列表，写「未验证真实规模」——v1 允许，但必须写）
- L 批重试了几次、最终是「模型抖」还是「产品坏」
- 顺带发现（非本发版引入的）→ 另开 issue，不挡 tag，除非是基础路径

---

## 7. 和维护约定

改了下面这些面的 PR，必须同 PR 改这份清单对应 ID 的选择器 / 步骤，否则发版套件会假绿或假红：

- Chat 空态 / composer / instance chip / Stop
- NewConfigWizard / InstancesList / custom provider 字段
- SessionDrawer 归档/删除
- Settings root 的 `data-testid="settings-row-*"` 或一级信息架构
- pin 行

功能 PR 的 `need-human-test` 继续只证明「这次新功能对」。本清单只证明「旧的基础没烂」。

---

## 8. v1 已定

F24（桥跟随）和 F13（custom provider）都进 v1。之后发现新回归，在本清单加 ID，并改 `eval/acceptance/release-smoke/` 同一份套件。

条数：F 24 + P 2 + L 5 + H 4。同一 profile 必须按序（先 F07 再 F09…）。F14 由 runner 关 context 再启同一 `user-data-dir`，不在 F 批中途做。
