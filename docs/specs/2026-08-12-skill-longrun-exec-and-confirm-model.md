# 视频解析分层策略 + Skill 脚本长任务执行模型 + 授权模型替换

- 日期:2026-08-12
- 状态:定稿(grilling 收敛;同日二次修订——加入分层策略,驱动关系反转,见 §2)
- 驱动场景:解析用户正在浏览的网页视频(总结/问答需要结合音画内容),并以此为楔子衍生一类新功能。

## 1. 背景

现有 `run_skill_script` 链路(daemon srt 沙箱执行磁盘 skill 脚本)是为秒级脚本设计的,视频解析这类分钟级任务在四处被硬阻断:

1. **60s 硬超时且超时丢弃全部 stdout**(`daemon/src/skill-sandbox.ts:15`、`skill-exec.ts:233`),任何真实视频任务必超时,且零诊断信息。
2. **无进度回传**:Bridge 协议只有 request/response 单帧回复,脚本执行期间对话纯黑盒;沙箱执行还是全局串行队列、排队无超时,一个卡住的 run 会堵死后续一切 skill 调用,而扩展侧 `send()` 无超时兜底(`local-bridge.ts:168`)——对话永久挂起。
3. **用户中止不生效**:`run_skill_script` handler 不消费 `ctx.signal`,daemon 无 kill 通道。
4. **网络白名单语义撑不住场景**:grant 信封的静态域名白名单无法枚举视频 CDN(yt-dlp 支持上千站点,`googlevideo`/`bilivideo` 各种子域)。

同时,grilling 过程中做出一个超出本场景的架构决策:**整体删除 grant 信封体系**,skill 脚本授权改为与 agent 既有确认层(panel-request/HITL 原语)集成。理由见 §4。

定稿后的二次讨论进一步反转了驱动关系:视频解析的大部分用户价值不需要走到「本地重计算」层,分层策略见 §2;本地执行地基(§3-§6)设计保持有效,但优先级改由 L3 的真实缺口拉动。

## 2. 视频解析分层策略与算力分工(顶层图景)

### 2.1 关键事实

这个场景的难点不是「转写/理解」,是**「从网页 URL 拿到媒体流」**。理解侧的算力(vision LLM、whisper 类 ASR)供给充足;抽流这一步要么本地跑 yt-dlp,要么灰色第三方服务,要么限平台。而抽帧/抽音频本身是 CPU 极轻的操作(ffmpeg 秒级),不构成「服务」,谁拿到流谁顺手做。

### 2.2 分工原则(拍板)

> **媒体处理(拿流、抽帧、抽音频)永远在客户端;官方(managed)与 BYOK 只提供模型算力(vision + whisper)。**

- 灰色环节(绕平台限制抓流)永远留在用户设备上,责任归属与任何本地下载工具一致;官方基础设施只卖干净算力。
- 画面理解 = vision LLM:BYOK 用户用自己的 vision 模型,managed 阵容已有 `models[].vision` 字段,**零新建设**。
- 音频转写 = whisper 类模型:仅被 L3 需要(L1 字幕即文本、L1.5 走 vision)。managed 侧 = LiteLLM 挂转写别名进现有周额度记账(跨仓库,后端条目另立);BYOK 侧 = audio API 与现有 chat wire 不同,属新能力面,随 L3 一起设计。
- 计费两边都不动:managed 走现有订阅+周额度,BYOK 由供应商直接计费,不引入按量模式。

### 2.3 三层梯子

| 层 | 路径 | 依赖 | 覆盖 |
|---|---|---|---|
| **L1 字幕抓取**(先做) | agent 操作页面打开 transcript/CC 面板读文本(扩展就在页面里,主场优势) | 现有 agent 能力,最多一个轻量引导 skill | 有字幕视频,估计真实需求 80%+ |
| **L1.5 主场截帧** | agent 控制播放器 seek → `chrome.tabs.captureVisibleTab` 截屏裁出画面 → vision LLM;关键帧时间点由 LLM 按字幕/章节挑 | `<all_urls>` 已有;可能需一个轻量 read-class tool;不受 canvas 跨域污染限制 | 非 DRM、tab 可见;补齐「结合画面」的理解 |
| **L3 本地媒体处理 skill**(后置,由缺口拉动) | 本地 skill:yt-dlp 拿流 + ffmpeg 抽帧/抽音频 → 帧走 vision、音频走 whisper 算力 | Pie Link + 本地执行地基(§3-§6)+ 依赖 which 检测 | 无字幕长尾站点、产物型需求、隐私敏感 |

### 2.4 已否决的选项(非后置,是划掉)

| 选项 | 否决理由 |
|---|---|
| Gemini 直传 YouTube URL(音画全解析) | 不能假设用户已配 Gemini key,BYOK 产品不为单一 provider 建路径 |
| 服务端抓取(官方跑 yt-dlp) | 三重否决:①合规主体变成我们(YouTube ToS,产品命脉在 Google 手里);②运维无底洞(数据中心 IP 被拦,要住宅代理池+反爬军备竞赛);③放弃「扩展在用户会话里」的唯一结构性优势 |
| 第三方 URL→transcript SaaS 进产品 | 要用户配小众 key,稳定性/合规灰;可作为用户自装的轻 skill 存在,不进产品 |
| 重型视频理解 API(Twelve Labs 类) | 面向企业视频库索引,与「解析正在看的视频」错配 |
| `chrome.tabCapture` 实时录音→ASR | 录 1 小时视频要播 1 小时,不实用 |

## 3. 地基决策总览(本地执行模型,L3 拉动)

| # | 决策 | 结论 |
|---|---|---|
| D1 | 执行模型 | **同步 tool call 保持不变**。LLM 视角仍是一次调用等到结束;不引入异步 job handle(无真实并行收益,只有 loop 语义复杂化) |
| D2 | 超时 | **删除超时机制**(删 `TIMEOUT_MS`,不引入任何超时配置)。终止权 = 用户 abort + 断连收尸。与 agent loop 已确立的「无硬护栏、终止权归 LLM/用户」哲学一致 |
| D3 | 中止 | **abort → kill RPC**:用户中止任务时扩展调 daemon 杀进程;**断连收尸**:bridge 连接断开时 daemon kill 该连接发起的全部 in-flight run |
| D4 | 进度 | **轮询,不动 wire 骨架**:扩展生成 `runId` 随 `run_skill_script` 传入,等待期间轮询新 RPC `poll_skill_run` 拿 `{state, elapsedMs, stdoutTail}` 渲染 UI;LLM 无感知 |
| D5 | 授权模型 | **删除 grant 信封整套**(声明/信封/hash/grants.json/TOCTOU 重调)。替代:SW 层 panel-request 确认卡,**会话内记住**;沙箱降为固定基线不可配 |
| D6 | 网络 | 随 D5 消解:固定基线沙箱**网络全放**,不再有域名声明。外泄面由 env 擦除(D7)+ denyRead 基线压制 |
| D7 | env | **白名单擦除**:子进程只拿 `PATH`(login-shell 解析版)+ `HOME` + `TMPDIR` + `LANG`/`LC_*` + `USER` + `SHELL` + `PIE_*`/`BUN_BE_BUN`,其余全擦。网络全放后这是必须项,不是可选项 |
| D8 | 产物读取 | `read_skill_output` 加单次 256K 字符上限 + `truncated` 标记 + 可选 `offset` 续读参数(现状无上限,大转写文本会直灌 LLM context) |
| D9 | 并发 | **保持全局串行**(srt SandboxManager 单例)。`poll_skill_run` 透出 `queued` 态,排队可见即可,v1 不做并发 |
| D10 | 兼容 | 授权模型变更是 wire 语义破坏:`PROTOCOL_VERSION` 1→2,daemon 对 v1 客户端拒绝 `run_skill_script` 并引导升级;扩展抬 `MIN_DAEMON_VERSION` 触发既有升级卡。`grants.json` 遗留文件不迁移不清理 |

## 4. 授权模型:删信封,集成 agent 确认层

### 4.1 为什么删

信封模型(SKILL.md 静态声明能力 → 首跑弹权限清单 → 持久 grant)是 app-store 式授权,错在抽象层级:

- 用户批准的真实心智是「我信任这个 skill 做它声明的事」,不是逐条审计域名/路径清单——`upos-hz-mirrorakam.akamaized.net` 这种条目用户无从判断,清单只制造虚假的知情同意。
- 静态声明在「不可枚举资源」(视频 CDN)面前必然失效,要么白名单形同虚设的宽通配,要么实质不可用。
- daemon 侧授权校验(信封 hash、TOCTOU 重调)的威胁模型价值极低:能连 `~/.pie/daemon.sock` 的本地进程本来就是用户权限进程,不需要绕 Pie 才能执行命令。真正的信任边界只有一条——**LLM 不能自批**,而这条在 SW 层保证即可。
- Claude Code 等同类 agent 对 skill 脚本的处理就是工具级确认(bash 确认卡),`~/.agents/skills` 跨 agent 对齐也指向这个方向。

### 4.2 拆除清单

- SKILL.md `metadata.pie.*` 能力声明解析(`daemon/src/skill-md.ts` 的 network/write 部分;`invalidNetwork` 作者信号一并删)
- `GrantEnvelope` / `envelopeHash` / `SkillAuthPayload` / `skill_auth_required` 错误码(`src/types/local-bridge.ts:198-219`)
- `~/.pie/grants.json` + `putGrant`/`revoke_grant`/`grantKey`(`daemon/src/grants.ts`)
- `run_skill_script` 参数中的 `grantApproved` / `approvedEnvelopeHash` 注入与校验(`skill-script.ts:200-207`、`skill-exec.ts:184-200`)
- 设置页「本地打通」的 grant 列表/撤销 UI(「最近执行」`list_audit` 保留)
- `skill-grant` panel-request 类型(被新确认卡类型取代)

### 4.3 替代模型

- **确认时机**:SW 在向 daemon 发 `run_skill_script` 前检查本会话批准记录;未批准 → 走 panel-request 原语弹确认卡。
- **卡片内容**:skill 名 + description + 要执行的 entry + args 全文(args 含视频 URL 等,用户看得到这次要干什么)。
- **记忆粒度**:**会话内记住**(per session × per skill)。批准记录写进 session 持久状态(IDB,随 session 恢复)——不能只放 SW 内存,MV3 SW 随时死,会导致同会话重复弹卡。新会话重新确认;skill 更新无需重弹锚,下个会话自然重新确认。
- **LLM 不可自批**:批准信号由 panel 直达 SW,不进 tool schema,与现有 panel-request 语义同构。
- **无超时**:panel 关闭时按 panel-request 现有 reject 语义处理,确认卡本身不加超时(与 D2 哲学一致)。
- **daemon 侧**:不再做任何授权校验,收到 `run_skill_script` 即按固定基线沙箱执行(信任边界见 §3.1 第三点)。

### 4.4 固定基线沙箱(不可声明、不可配)

| 维度 | 基线 |
|---|---|
| 写 | 仅 session workspace(`~/.pie/sessions/<sid>/workspace/`);skill 目录(含只读副根)永不可写。原 `metadata.pie.write` 额外写路径能力删除,现无真实用例,需要时再加 |
| 读 | 沿用 `baselineDenyRead`(`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.pie/logs` 等;`grants.json` 条目随文件一起删) |
| 网络 | **全放**。实现时验证 srt 的全放语义(`allowedDomains: ["*"]` 是否被 0.0.67 支持;否则 daemon 侧特判跳过 network 限制维度) |
| env | 白名单擦除,见 D7。`PATH` 必须用 daemon 已有的 login-shell PATH 解析结果(`agents.ts` detect 机制复用)——launchd 裸 PATH 找不到 homebrew 的 yt-dlp/ffmpeg |
| 进程 | srt 进程级沙箱,子进程(脚本 spawn 的 yt-dlp/ffmpeg)继承 profile——实现时验证 |

## 5. 执行模型改造

### 5.1 生命周期

```
LLM 调 run_skill_script
  → SW 查本会话批准记录,未批准 → panel-request 确认卡(挂起,无超时)
  → 批准 → SW 生成 runId(uuid),随 RPC 传给 daemon
  → daemon 入串行队列 → 执行(无超时)
  → 扩展侧等待期间每 1s 调 poll_skill_run(runId) → UI 渲染 queued/running + elapsed + stdout tail
  → 结束 → RPC 返回 observation(现有 1MiB capped buffer 语义不变)
终止路径(仅两条):
  a) 用户 abort → 扩展调 kill_skill_run(runId) → daemon 杀进程,RPC 以 killed 错误返回
  b) bridge 连接断开(SW 死/扩展关/用户关本地打通)→ daemon kill 该连接全部 in-flight run
```

### 5.2 wire 变更(`src/types/local-bridge.ts`,加法 + 一处破坏)

- `run_skill_script` 参数:+`runId`;−`grantApproved`/−`approvedEnvelopeHash`(破坏,见 D10)
- 新增 `poll_skill_run { runId } → { state: "queued"|"running"|"done", elapsedMs, stdoutTail }`
- 新增 `kill_skill_run { runId } → { ok }`
- `PROTOCOL_VERSION` 1→2;daemon 对声明 v1 的客户端拒绝 `run_skill_script`(错误信息引导升级扩展);扩展抬 `MIN_DAEMON_VERSION` 走既有升级卡
- 进度 tail 用 daemon 侧独立 ring buffer(约 8KB,保留末尾),与 observation 的 1MiB capped buffer 分离——yt-dlp 的 `\r` 进度刷屏不能吃掉 observation 预算

### 5.3 daemon 侧要点

- 删 `TIMEOUT_MS` 及 `timedOut` 分支(「超时丢 stdout」的坑随之消失,无需单修)
- run 注册表按 socket 连接归属追踪(现有 `beginSkillRun/endSkillRun` 扩展),连接断开触发收尸
- 排队中的 run 被 kill/收尸时直接出队,不进沙箱
- audit 每条加记沙箱基线摘要(env 白名单版本、网络全放标记),`list_audit` 继续服务设置页「最近执行」

### 5.4 扩展侧要点

- `run_skill_script` handler 消费 `ctx.signal`:abort 时发 `kill_skill_run` 并解除等待
- 轮询驱动的 tool 卡片执行中态(elapsed + stdout tail 几行 + 取消按钮);`queued` 态显示排队中
- stdout tail 属于 skill 输出,是不可信数据,UI 按纯文本渲染(与 observation 的 `untrusted_*` 包裹同一纪律,不进 LLM 上下文)

## 6. read_skill_output 防护(D8)

- 单次返回上限 256K 字符;超限截断,observation 追加 `truncated` 标记与总长度
- 新可选参数 `offset`(字符偏移)供 LLM 续读
- 保持 utf8 文本语义;二进制文件交付不在本期(见 §7)

## 7. 验证场景(按分层顺序)

**第一验证场景 = L1 字幕抓取**(取代原 L3 场景):
- 「总结这个视频」在 YouTube / B 站有字幕视频上端到端:agent 操作页面打开 transcript/CC 面板 → 读文本 → 摘要/问答回对话
- 形态:现有 agent 能力优先;若引导成功率低,固化为 builtin 引导 skill(纯 instructions,无脚本)
- 观测数据:无字幕视频的出现率(决定 L3 拉动时机)、transcript 面板操作的成功率

**第二验证场景 = L1.5 主场截帧**:
- 「这个视频第 N 分钟画面里是什么/结合画面总结」:seek → 截帧 → vision 模型
- 实现细节(新 tool 形态、裁剪、DRM 黑屏的 fail 语义)留 issue 阶段
- 前置检查:所选 vision 模型不可用时的降级提示(`filterToolsByVision` 纪律沿用)

**L3 验证场景(后置,地基完工时用)**:磁盘 skill(`~/.pie/skills/video-parser/`),`scripts/` 单入口收视频 URL;`which yt-dlp ffmpeg` 缺失时 print 引导安装并退出;抽帧+抽音频写 workspace,帧走 vision、音频走 whisper 算力,LLM 经 `read_skill_output` 分段读回;验收含确认卡 → 进度可见 → 可取消 → 断连收尸四条路径真机验证。

## 8. 明确不做(后置)

| 项 | 触发再投的条件 |
|---|---|
| **L3 本地媒体处理地基落地**(§5 执行模型改造) | L1/L1.5 观测到的无字幕/截帧不可用缺口率 |
| **whisper 转写算力**(managed 挂别名 + BYOK audio wire) | 仅被 L3 需要,随 L3 拉动;managed 侧跨仓库另立后端条目 |
| 依赖 bootstrap(daemon 托管 yt-dlp/ffmpeg 安装) | L3 落地后 `which` 失败引导的真实摩擦率 |
| 大文件/二进制产物交付通道(workspace → 用户下载) | 出现「要视频文件本体」的真实需求;native messaging 1MB 单帧上限需分块设计 |
| 沙箱并发执行 | 串行排队在真实使用中成为可感知瓶颈 |
| 「总是允许」持久批准 | 会话内记住被反馈为烦 |
| 登录态视频(浏览器 cookie 导给 yt-dlp) | 高危能力,明确不做;接受覆盖面损失 |
| 按域名事后 audit 明细 | 全网放行上线后有安全审查需求时 |

## 9. 实现切片建议(issue 阶段细化)

1. **L1 字幕抓取**(先行,近零成本):现有能力验证 +(按需)builtin 引导 skill。不碰 daemon。
2. **授权模型替换**(独立价值,不等 L3):拆信封 + panel-request 确认卡 + 会话批准记录 + env 擦除 + `read_skill_output` 防护 + PROTOCOL_VERSION 1→2 + 抬 `MIN_DAEMON_VERSION`。这是唯一的 wire 破坏点,单独构成一次 daemon breaking 发版。
3. **L1.5 主场截帧**:seek + captureVisibleTab + vision 喂帧。不碰 daemon。
4. **长任务执行模型**(§5,后置由 L3 拉动):删超时 + runId/poll/kill RPC + 断连收尸 + 轮询 UI 与 abort 联动。**wire 全是加法**(破坏点已随切片 2 发掉),后置发版不需要第二次抬 `MIN_DAEMON_VERSION`。
5. **视频解析 L3 skill 本体 + whisper 算力**(依赖 4;whisper 的 managed 侧跨仓库)。

注:原「切片 1、2 合并发版」的约束已被新顺序消解——wire 破坏全部集中在切片 2,切片 4 纯加法演进,升级卡只弹一次。
