# 视频/媒体解析:媒体处理永远在客户端,官方与 BYOK 只提供模型算力

视频解析场景(总结/问答用户正在看的网页视频,需结合音画)引出「解析能力放哪」的问题:本地 skill(yt-dlp/ffmpeg/whisper)、官方托管服务、还是第三方 API?

**决定**:

1. **媒体处理(拿流、抽帧、抽音频)永远在客户端**。灰色环节(绕平台限制抓流)责任归属留在用户设备上,与任何本地下载工具一致;抽帧/抽音频本身是 CPU 极轻操作,谁拿到流谁顺手做,不构成「服务」。
2. **官方(managed)与 BYOK 只提供模型算力**:画面理解 = vision LLM(两边已具备,零新建设);音频转写 = whisper 类模型(managed 挂 LiteLLM 转写别名进现有周额度;BYOK 的 audio wire 随需要再设计)。计费模式两边都不动。
3. **官方永不做服务端抓取**。这不是优先级后置,是结构性划掉:①合规主体从用户变成我们(YouTube ToS,而产品命脉——商店上架/OAuth——攥在 Google 手里);②运维无底洞(数据中心 IP 被平台全面拦截,需住宅代理池 + 持续反爬军备竞赛,与浏览器 agent 完全不同的能力域);③放弃「扩展就在用户浏览器会话里」的唯一结构性优势——用户的 IP、登录态、正在播放的会话,是纯 SaaS 拿不到的。
4. **解析路径分层,优先吃零成本层**:L1 字幕/transcript 面板抓取(页面内,现有能力,估计覆盖 80%+)→ L1.5 主场截帧(seek + `captureVisibleTab` → vision)→ L3 本地媒体处理 skill(yt-dlp+ffmpeg,由 L1/L1.5 观测到的缺口拉动,依赖长任务执行地基)。

**被拒的备选**:Gemini 直传 YouTube URL(不能假设用户配了特定 provider,BYOK 产品不为单一 provider 建路径);第三方 URL→transcript SaaS 进产品(小众 key、合规灰;可作为用户自装轻 skill 存在);重型视频理解 API(企业视频库索引,场景错配);tabCapture 实时录音(录多久播多久,不实用)。

**下游影响**:视频解析功能的建设顺序反转(L1 先行,本地执行地基后置由缺口拉动,见 spec §9 切片);whisper 转写别名是 pie-managed-backend 的跨仓库条目;未来任何「官方帮用户处理媒体」的提案先对照本 ADR 第 3 条。

设计全文:`docs/specs/2026-08-12-skill-longrun-exec-and-confirm-model.md` §2。
