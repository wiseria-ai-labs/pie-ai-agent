# Pie Link Windows 托盘 app

macOS 顶栏 app（`daemon/menubar/`）的 Windows 对应物，收敛版。权威设计：
`docs/specs/2026-08-05-daemon-windows-support.md` §4.6。

## 是什么

- **技术栈**：C# 编译到 .NET Framework 4.8 的**单 exe**（`PieTray.exe`）。Win10 22H2+ /
  Win11 系统自带 runtime，零运行时分发依赖；CI windows runner 自带 `csc`。
- **单文件源**：`PieTray.cs`（WinForms `NotifyIcon` + `ApplicationContext`，无可见窗口）。
- **与 daemon 通信**：连 named pipe `\\.\pipe\ai.wiseria.pie`，复用 **status RPC**
  （一问一答，一行 JSON 请求 / 一行 JSON 响应，同 mac 顶栏 app 的瘦客户端语义）。
  wire 框架见 `src/types/local-bridge.ts`（`StatusResult`，加法演进不 bump
  `PROTOCOL_VERSION`）。

## 行为（对齐 mac 收敛版）

- **两态图标**：已连接（品牌图标原色 = 深圆角底板 + 白派 + 右上咬口）/ 未连接（同图整体压
  alpha 到 40% 变淡）。每 3s 轮询 status RPC，daemon 起停时随之切换；运行期查询在线程池，
  UI 更新 marshal 回主线程。图标来自嵌入的 `pie.ico`（见下「品牌图标资产」）。
- **菜单三项**：
  1. **状态行**（禁用）：`Pie Link v<ver> · 运行中` + 浏览器扩展连接态；daemon 未响应时
     显示「未运行」。菜单点开时 fresh 查一次。
  2. **打开日志目录**：在资源管理器打开 `%USERPROFILE%\.pie\logs`。
  3. **退出 Pie Link**：按 `StatusResult.pid` 结束 daemon 进程后退出托盘（Docker
     Desktop 模型，对齐 mac「退出 = 图标与后台服务一起停」）。托盘因其它原因退出
     （注销 / 任务管理器）**不**动 daemon——两进程独立，只有此菜单项才杀 daemon。

## 构建

```powershell
# 产物 PieTray.exe 落 daemon/dist/（或指定 -OutDir）
.\build-tray.ps1 -Version 1.2.0
```

`build-tray.ps1` 直接调 `csc`（对齐 mac `build-app.sh` 直调 `swiftc` 的路线，不引项目
系统）。引用 GAC 内的 `System.Web.Extensions.dll`（`JavaScriptSerializer` 解析 status
JSON）等 net48 自带程序集，运行期无第三方依赖。

**编译器**：需要 Roslyn 版 `csc`。系统内置的
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 是 **C# 5** 编译器，编不了本文件里的
字典索引初始化（C# 6）与 `out var`（C# 7），会报一屏 CS1525。`build-tray.ps1` 的解析顺序：
`$env:PIE_CSC` → vswhere 找到的 VS 内 Roslyn（GitHub windows runner 走这条）→ 回落下载固定
版本的 `Microsoft.Net.Compilers.Toolset` 并缓存到 `%LOCALAPPDATA%\pie-build\`（只下一次）。

**编码**：`PieTray.cs` 与 `build-tray.ps1` 必须存成**带 BOM 的 UTF-8**。中文系统的
Windows PowerShell 5.1 按 ANSI(GBK) 读无 BOM 的 `.ps1`，中文注释乱码后语法直接崩；`csc`
同样会把无 BOM 源码按 ANSI 读，六语言菜单文案会乱码进 exe。

## 品牌图标资产

`pie.ico` 是 checked-in 的多档图标（16/24/32/48/64/128），从扩展品牌资产
`public/icons/icon-128.png` 一次性生成后提交进仓库（构建期零工具依赖）。**只有品牌图标本身
改了才需要重跑：**

```bash
python3 -c "from PIL import Image; Image.open('public/icons/icon-128.png').convert('RGBA').save('daemon/tray-win/pie.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128)], bitmap_format='bmp')"
```

⚠️ **两条约束，改命令前先读：**

1. **档位最大到 128，不要放 256。** Pillow 对 >255 px 的档写 PNG-compressed ICO 条目，
   而 .NET Framework 的 `System.Drawing.Icon` 对 PNG 条目支持不可靠（黑块 / 抛异常）。
2. **必须带 `bitmap_format='bmp'`。** Pillow 12.x 默认把**所有**档都写成 PNG-compressed
   条目（不再是「>255 才 PNG」的老行为），会踩同一个 .NET PNG 条目坑。显式指定 `bmp` 强制
   每档写 BMP/DIB 才安全（生成物约 100 KB，仍是小文件）。

`pie.ico` 经两处接入：
- `build-tray.ps1` 的 `/win32icon:pie.ico`（PE 文件图标）+ `/resource:pie.ico,pie.ico`
  （运行期可读资源，`PieTray.BuildBitmap` 用 `GetManifestResourceStream("pie.ico")` 读回）。
- `install-win/pie-link.iss` 的 `SetupIconFile=..\tray-win\pie.ico`（安装器 exe / 向导窗口图标）。

## 接线状态

- **CI / 安装器接入**（#363，已接）：`.github/workflows/release.yml` 的 `build-daemon-win`
  job 调 `build-tray.ps1 -OutDir daemon\dist` 产出 `PieTray.exe`，Inno 安装器
  （`daemon/install-win/pie-link.iss`）把它装进 `%ProgramFiles%\Pie Link\`、写 HKLM `Run`
  key 登录自启托盘、装完立即以调用者身份启动。daemon 由 host 兜底拉起（spec §4.4）。
- **代码签名**：首期不签（接受 SmartScreen 摩擦），CI 留签名步骤占位（spec §5 / 决策 9）。
- **品牌图标**（#379，已接）：托盘两态、exe 文件图标、安装器 / 卸载项图标全部走 checked-in
  的 `pie.ico`（见上「品牌图标资产」）。
- **真机验收**：托盘两态切换 / 三菜单项行为走 PR 的 `need-human-test`。
