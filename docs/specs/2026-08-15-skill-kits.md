# Skill 与 Kit（套件）解耦

- 日期: 2026-08-15
- 状态: 方向草稿（尚未落地；video-parser skill 已撤回，等本基座想清楚再做上层）
- 驱动: 视频解析 L3 暴露「用户要懂 PyInstaller / Python 版本 / 沙箱信号量」——这是依赖泄漏进产品面，不是 skill 写坏了

## 1. 问题

现在本地能力的安装心智是乱的：

- skill 是一份 SKILL.md + `scripts/`
- 真正能不能跑，取决于机器上有没有 `yt-dlp`、什么发行版、Python 几、沙箱允不允许 PyInstaller
- 确认卡和设置页把二进制名字直接摊给用户
- 每个 skill 自己 `which`、自己打印 brew 文案，装上 skill ≠ 功能可用

这套东西撑不住「写完 / 市场上安装一个 skill，对应功能就能用」，更撑不住以后的 skill 市场：作者不能也不该在每个 skill 包里塞一份 ffmpeg。

## 2. 两个东西，两个生命周期

| | **Skill** | **Kit（套件）** |
|---|---|---|
| 是什么 | 怎么做事（instructions + 可选脚本） | 做事所需的运行时（平台二进制 / 解释器 / 模型文件） |
| 谁写 | skill 作者、用户、市场 | Pie 官方（v1）；以后才考虑第三方 kit |
| 谁装 | 用户选 skill / 导入 / 市场一点 | 装 skill 时按声明自动解析；用户只看到套件名 |
| 变的频率 | 文案和流程常改 | 按平台发版，带校验和 |
| 例子 | `video-parser` | `media-extract@1`（内含可用的 yt-dlp + ffmpeg，已按沙箱约束打好） |

Skill **不**声明 `yt-dlp`、`ffmpeg`、`python3.14`。它只声明需要哪个 kit、哪个主版本。

Kit **不**含任务逻辑。它只 `provides` 一组稳定命令名（对脚本仍是 `yt-dlp`，对用户不可见）。

## 3. 声明

Skill 包根增加一份小清单（SKILL.md frontmatter 或并列 `kit.json`，落地时二选一、不要两套）：

```yaml
requires:
  - kit: media-extract
    version: "^1"
```

这不是 ADR 0007 删掉的 `metadata.pie.network/write`。那是沙箱能力声明，已证明是错抽象。Kit 声明是**运行时依赖**，和 npm `dependencies` 同构，和权限信封无关。

未声明 kit 的 skill：行为与现在纯脚本 skill 相同（只靠系统 PATH）。不强迫旧 skill 改。

## 4. 解析与安装（「装上就能用」）

```
install / 启用 / 首次 run_skill_script
  → 读 requires
  → 对每个 kit：~/.pie/kits/<id>/<resolvedVersion>/ 是否已有且校验通过
  → 缺：弹一张人话卡「「视频解析」需要安装「媒体提取」套件（约 40MB）」
        [取消] [安装]
  → 下载官方 kit 包（URL 白名单 + sha256 + 平台三选一）
  → 解到 kits 目录，只读
  → 本次及以后该 skill 的 PATH = kit/bin + ~/.pie/bin + login-shell PATH
```

用户可见名词只有套件的展示名。失败文案是「套件安装失败 / 该套件暂不支持此系统」，不是 semctl、不是 PyInstaller。

同一 kit 被多个 skill 引用只装一次。

## 5. 执行期

`run_skill_script` 在现有固定基线沙箱上，额外：

- `PATH` 前置本次 skill 解析到的全部 kit `bin/`
- `TMPDIR` 仍钉在 session workspace（PyInstaller / 解包类工具的写需求）
- kit 目录对脚本只读（和 skill 目录一样）
- **官方 kit 的打包约束**：macOS 禁止 onefile PyInstaller（sandbox-exec 拒 `semctl`）。官方 kit 只收 zipimport / 静态链接 / 解释器包装，由 kit 构建流水线保证，作者和用户都不用知道。

脚本里继续写 `yt-dlp`。解耦发生在「谁负责让这个名字能跑」，不发生在改脚本 API。

## 6. 和市场的关系

市场包分两类，不要混进同一个 zip：

1. **Skill 包**：SKILL.md + scripts + `requires`。体积小，可审，可改。
2. **Kit 包**：按 `os-arch` 分发的运行时。v1 **只允许官方 kit**（和 Pie Link 同一条信任链：白名单 URL + sha256）。第三方 kit 是单独的信任模型，不在第一期。

作者在市场发布「视频总结」时，只标 `requires: media-extract@^1`。用户点安装 → 拉 skill → 拉（或复用已装的）kit → 能跑。ffmpeg 不会被复制进每一个 skill。

## 7. 过渡

当前 PR 里「Settings / 确认卡代装 yt-dlp、ffmpeg 到 `~/.pie/bin`」= 未命名的、唯一的隐式 kit。落地 Kit 机制时：

- 把它收成官方 `media-extract@1`（或当时定下的第一个官方 kit）
- 上层 skill（含暂停中的视频解析 L3）再声明 `requires`
- `~/.pie/bin` 里已装的 helper 可迁入 kit 或继续当 PATH 回落
- 确认卡文案从二进制名改成套件名

在 Kit 机制落地前，不把「套件」写进用户可见 UI（名不副实）。

## 8. 明确不做（本期设计）

- 第三方 kit 市场上架
- skill 包内嵌 ffmpeg 当「便携 skill」
- 把 brew / pip 当主安装路径
- 浏览器 cookie 打进 kit（仍是 ADR 0008 / 登录态不做）
- 再引入 `metadata.pie.*` 权限信封
