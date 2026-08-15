# Skill 声明 Kit，不声明二进制

视频解析 L3 把 yt-dlp / ffmpeg / Python 版本 / PyInstaller 信号量摊到用户和 skill 作者面前。装上 skill 功能仍不可用；每个 skill 各自探测依赖，没法复用，也撑不住以后的 skill 市场。

**决定**:

1. **拆成两层**：**Skill** = 怎么做（instructions + 脚本）；**Kit（套件）** = 做它所要的运行时（按平台打包的二进制 / 解释器）。用户装 skill；kit 按声明自动解析。
2. **Skill 只声明 kit id + 主版本**（`requires: [{ kit: media-extract, version: "^1" }]`），不声明 `yt-dlp`、`ffmpeg`、`python3`。脚本内部仍可调用这些命令名——解耦在安装与 PATH 装配，不在改 CLI。
3. **Kit 是独立包，不是 skill 的附件**。多个 skill 共享同一 kit；官方 kit 放 `~/.pie/kits/<id>/<version>/`，只读。v1 只发官方 kit（与 Pie Link 同一信任链：URL 白名单 + sha256）。
4. **「装上就能用」是安装器的职责**，不是作者在 SKILL.md 里写 brew。首次运行缺 kit 时弹一张人话确认卡（套件展示名 + 体积），批准后下载。失败不泄漏 semctl / PyInstaller。
5. **官方 kit 必须能在固定基线沙箱里跑**。macOS 禁止 onefile PyInstaller（`semctl` 被 sandbox-exec 拒绝）。这是 kit 构建约束，不是用户配置项。
6. **当前 `~/.pie/bin` 代装 helper 是过渡**，语义上等于未命名的 `media-extract@1`。Kit 机制落地后迁入，不在用户 UI 提前改称「套件」。

**不选的备选**:

- 每个 skill 自带 ffmpeg：包膨胀、更新 N 份、市场审核无法规模化。
- 继续让用户装 Homebrew / pip：装上 skill ≠ 能用，且大量用户没有权限或不愿碰终端。
- 把依赖写回 `metadata.pie.*`：ADR 0007 已证明那是权限信封，不是依赖图。

**下游影响**: 新 wire（`list_kits` / `ensure_kits`）加法演进；`run_skill_script` 的 PATH 装配改为「kit bins + 原 PATH」。市场包格式要能表达 `requires`，skill zip 与 kit zip 分发通道分开。设计全文：`docs/specs/2026-08-15-skill-kits.md`。
