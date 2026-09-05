# Pie Link Windows 安装器（Inno Setup）

macOS `.pkg`（`daemon/install/`）的 Windows 对应物。权威设计：
`docs/specs/2026-08-05-daemon-windows-support.md` §4.2 / §4.5 + 实测发现 F1 / F5。

## 文件

- **`pie-link.iss`** — Inno Setup 6 脚本（唯一打包入口）。
- **`pie-host.bat`** — native messaging host wrapper。Chrome 只能在 manifest 里指一个不带
  参数的可执行路径，而 `pie.exe` 需要 `host` 子命令，故加这层 wrapper（两行 bat，真机
  2026-08-08 验证 Chrome 正常拉起、扩展正常连上——**不需要**单独编 `pie-host.exe`）。

## 装什么（→ `%ProgramFiles%\Pie Link\`，本地盘）

| 文件 | 来源 | 说明 |
|---|---|---|
| `pie.exe` | `bun build --compile --target=bun-windows-x64` | daemon，兼作 `host` / legacy `windows-*` 子命令 |
| `pie-host.bat` | 本目录 | native messaging wrapper |
| `PieTray.exe` | `daemon/tray-win/build-tray.ps1` | 最小托盘 app（C# net48） |

**为什么必须装本地盘 Program Files（F5）**：exe 位于网络路径（UNC / 映射盘 / VM 共享
文件夹）时提权进程找不到自身 → `ERROR_BAD_NETPATH`。`{autopf}` 天然规避。

## 安装器做什么

- **`[Registry]`**（全机器级 **HKLM**）：写 Chrome + Edge 的
  `NativeMessagingHosts\ai.wiseria.pie` 键（默认值 = manifest json 绝对路径，json 落
  **`{app}`（Program Files，全用户可读）**）+ **HKLM** `Run` key（登录自启**托盘**；daemon
  由 host 兜底拉起，spec §4.4）。`allowed_origins` 只收稳定扩展 ID
  `chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/`（manifest `key` 钉死，与
  Chrome Web Store 相同）**和** Edge Add-ons 商店稳定 ID
  `chrome-extension://gbfdgfkpglimajnjedphgakmhaplgobf/`（#35，2026-08-16 拍板）。
  **不要**把 unpacked 路径推导出的 ID 写进白名单——换目录就变，Pie Link 会再次失明。
  Edge 商店包去掉 `key` 只为过商店校验（本机 `scripts/make-edge-package.mjs`，
  **不**进 GitHub Release）；本机 Edge 验收必须加载**带 key 的 Chrome 包**才能对上
  `gpcc…`。商店用户装的是 Edge Add-ons 正式包，走第二条 origin。
  **为什么 HKLM 而非 HKCU**：这是提权的机器级安装（Program Files）。若标准用户凭**另一个**管理员账户提权，HKCU / `%LOCALAPPDATA%` 会落到那个管理员的
  hive/profile，而 Chrome 以标准用户身份跑 → 永远读不到 per-user 的 NM manifest。HKLM 的 NM
  host 键对每个用户都生效，manifest json 放 `{app}` 世界可读，从根上消掉这个身份错配。
  **清 HKCU 同名遮蔽键（防御性）**：Chrome / Edge 读 NM host 时 **HKCU 优先于 HKLM**，机器上若
  残留一份 HKCU `ai.wiseria.pie` 键（手工试装 / 旧 per-user 形态）会**静默遮蔽**安装器写的 HKLM 键，
  浏览器转而启动那份键指向的死路径 →「本地打通」连不上却看不出异常（PR #382 真机验收实际踩到）。
  ssPostInstall 里用 **`ExecAsOriginalUser` 跑 `reg delete`** 清掉 Chrome/Edge 两个 HKCU 键：
  之所以不用 `[Registry]` 的 HKCU `deletekey`，是因为提权安装下它解析到**发起提权的管理员** hive，
  而真正遮蔽的是**实际用浏览器的用户** hive；`ExecAsOriginalUser` 以原始调用者身份跑才命中后者。
  键不存在只是非零退出，容错不阻断。与 #365 给 `pie doctor` 的**检测**互补，这里是安装器**主动预防**。
- **`[Code]` ssPostInstall**（顺序，容错）：清 HKCU 遮蔽键 → 写 native manifest → 杀残留
  daemon → 以调用者身份启动托盘。Windows skill 脚本以用户权限直跑（无沙箱），安装器不再
  装沙箱设施，GUI 安装全程只有安装器自身一次 UAC。
- **卸载**：停托盘 → `pie.exe windows-uninstall`（legacy：清旧版残留的 `srt-sandbox` 账户 /
  WFP / ACE）→ 杀残留 daemon → 删注册表键 / `Run` 值 / `{app}\ai.wiseria.pie.json`。

## 构建

```powershell
# 前置：daemon/dist 里已备好 pie.exe / PieTray.exe
iscc /DMyAppVersion=1.2.3 daemon\install-win\pie-link.iss
# 产物 → daemon\dist\pie-link-setup-1.2.3.exe
```

- `MyAppVersion`（必给）= daemon/package.json 的 version；CI 从那里读。
- `DistDir`（可选，默认 `..\dist` = `daemon/dist`）= 上表 payload 的暂存目录。
- CI 接线见 `.github/workflows/release.yml` 的 `build-daemon-win` job（每 tag 交叉编译 +
  `choco install innosetup --version=6.7.1` + iscc → 上传 release asset）。**choco 版本固定在
  6.x**：ISCC 路径写死 `Inno Setup 6\ISCC.exe`，choco 包一旦跟进 Inno Setup 7 大版本，目录会变成
  `Inno Setup 7`、这步就找不到 ISCC 而 fail（且只在发 tag 时暴露）。要升 7 时同步改 pin 与路径。

## 尚未做（首期明确不含）

- **代码签名**：首期不签（接受 SmartScreen 摩擦，spec 决策 9）。`.iss` `[Setup]` 与 CI
  均留签名占位，拿到证书填 secrets 即生效。
- **品牌图标**：托盘图标目前代码画（琥珀色派），真 `.ico` 资产走 #379；届时
  `SetupIconFile` + PieTray 资源一并接入。
- 真机全流程验收走 PR 的 `need-human-test`（下载 → SmartScreen → 一次 UAC → 完成页 →
  托盘图标 → 扩展自动连接；卸载无残留；重装幂等）。
