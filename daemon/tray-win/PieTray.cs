// Pie Link Windows 托盘 app：`\\.\pipe\ai.wiseria.pie` 的瘦客户端。
// 对齐 mac 顶栏 app（daemon/menubar/main.swift）的收敛版：两态图标 + 三项菜单。
// 与 daemon 通信复用 status RPC（一问一答，一行 JSON 请求 / 一行 JSON 响应）。
// 编译：daemon/tray-win/build-tray.ps1（csc → net48 单 winexe，零运行时分发依赖）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PieLink
{
    internal static class Program
    {
        // named pipe basename，对齐 daemon/src/paths.ts 的 PIPE_NAME（加法演进不 bump PROTOCOL_VERSION）。
        internal const string PipeName = "ai.wiseria.pie";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var ctx = new TrayContext())
            {
                Application.Run(ctx);
            }
        }
    }

    /// <summary>菜单 / 状态文案本地化。跟随系统 UI 语言，覆盖扩展现有 6 个 locale，未命中回退 en。
    /// 品牌统一「Pie Link」，用户可见文案不出现 "daemon / 守护进程"（对齐 mac 顶栏 app 约定）。</summary>
    internal static class L10n
    {
        // 进程启动时定一次的目标语言（6 选 1）。
        internal static readonly string Lang = ResolveLang();

        private static string ResolveLang()
        {
            var c = CultureInfo.CurrentUICulture.Name.ToLowerInvariant();
            if (c.StartsWith("zh"))
            {
                if (c.Contains("hant") || c.Contains("-tw") || c.Contains("-hk") || c.Contains("-mo")) return "zh-TW";
                return "zh-CN";
            }
            if (c.StartsWith("ja")) return "ja";
            if (c.StartsWith("es")) return "es-419";
            if (c.StartsWith("pt")) return "pt-BR";
            return "en";
        }

        internal static string T(string key)
        {
            if (Table.TryGetValue(key, out var row))
            {
                if (row.TryGetValue(Lang, out var v)) return v;
                if (row.TryGetValue("en", out var en)) return en;
            }
            return key;
        }

        private static readonly Dictionary<string, Dictionary<string, string>> Table =
            new Dictionary<string, Dictionary<string, string>>
            {
                ["running"] = new Dictionary<string, string>
                {
                    ["en"] = "Running", ["zh-CN"] = "运行中", ["zh-TW"] = "運行中",
                    ["ja"] = "実行中", ["es-419"] = "En ejecución", ["pt-BR"] = "Em execução",
                },
                ["notRunning"] = new Dictionary<string, string>
                {
                    ["en"] = "Pie Link · Not running", ["zh-CN"] = "Pie Link · 未运行", ["zh-TW"] = "Pie Link · 未運行",
                    ["ja"] = "Pie Link · 停止中", ["es-419"] = "Pie Link · No está en ejecución",
                    ["pt-BR"] = "Pie Link · Não está em execução",
                },
                ["extConnected"] = new Dictionary<string, string>
                {
                    ["en"] = "Browser extension: Connected", ["zh-CN"] = "浏览器扩展：已连接",
                    ["zh-TW"] = "瀏覽器擴充功能：已連接", ["ja"] = "ブラウザ拡張機能：接続済み",
                    ["es-419"] = "Extensión del navegador: Conectada", ["pt-BR"] = "Extensão do navegador: Conectada",
                },
                ["extDisconnected"] = new Dictionary<string, string>
                {
                    ["en"] = "Browser extension: Disconnected", ["zh-CN"] = "浏览器扩展：未连接",
                    ["zh-TW"] = "瀏覽器擴充功能：未連接", ["ja"] = "ブラウザ拡張機能：未接続",
                    ["es-419"] = "Extensión del navegador: Desconectada", ["pt-BR"] = "Extensão do navegador: Desconectada",
                },
                ["notResponding"] = new Dictionary<string, string>
                {
                    ["en"] = "Pie Link service isn't responding. Try signing out and back in.",
                    ["zh-CN"] = "Pie Link 服务未响应，可尝试重新登录",
                    ["zh-TW"] = "Pie Link 服務未回應，可嘗試重新登入",
                    ["ja"] = "Pie Link サービスが応答しません。再ログインしてください",
                    ["es-419"] = "El servicio de Pie Link no responde. Intenta volver a iniciar sesión.",
                    ["pt-BR"] = "O serviço do Pie Link não está respondendo. Tente sair e entrar de novo.",
                },
                ["diagnostics"] = new Dictionary<string, string>
                {
                    ["en"] = "Diagnostics", ["zh-CN"] = "诊断", ["zh-TW"] = "診斷",
                    ["ja"] = "診断", ["es-419"] = "Diagnóstico", ["pt-BR"] = "Diagnóstico",
                },
                ["repairSandbox"] = new Dictionary<string, string>
                {
                    ["en"] = "Repair Sandbox", ["zh-CN"] = "修复沙箱", ["zh-TW"] = "修復沙箱",
                    ["ja"] = "サンドボックスを修復", ["es-419"] = "Reparar sandbox",
                    ["pt-BR"] = "Reparar sandbox",
                },
                ["diagTitleOk"] = new Dictionary<string, string>
                {
                    ["en"] = "Diagnostics — All Good", ["zh-CN"] = "诊断 — 一切正常",
                    ["zh-TW"] = "診斷 — 一切正常", ["ja"] = "診断 — 問題なし",
                    ["es-419"] = "Diagnóstico — Todo en orden", ["pt-BR"] = "Diagnóstico — Tudo certo",
                },
                ["diagTitleProblem"] = new Dictionary<string, string>
                {
                    ["en"] = "Diagnostics — Problems Found", ["zh-CN"] = "诊断 — 发现问题",
                    ["zh-TW"] = "診斷 — 發現問題", ["ja"] = "診断 — 問題が見つかりました",
                    ["es-419"] = "Diagnóstico — Se encontraron problemas",
                    ["pt-BR"] = "Diagnóstico — Problemas encontrados",
                },
                ["openLogs"] = new Dictionary<string, string>
                {
                    ["en"] = "Open Logs Folder", ["zh-CN"] = "打开日志目录", ["zh-TW"] = "開啟日誌目錄",
                    ["ja"] = "ログフォルダーを開く", ["es-419"] = "Abrir carpeta de registros",
                    ["pt-BR"] = "Abrir pasta de registros",
                },
                ["quit"] = new Dictionary<string, string>
                {
                    ["en"] = "Quit Pie Link", ["zh-CN"] = "退出 Pie Link", ["zh-TW"] = "結束 Pie Link",
                    ["ja"] = "Pie Link を終了", ["es-419"] = "Salir de Pie Link", ["pt-BR"] = "Sair de Pie Link",
                },
            };
    }

    /// <summary>daemon status RPC 的一问一答瘦客户端。菜单点开 / 轮询 tick 才查询，无常驻连接。</summary>
    internal static class DaemonClient
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        internal sealed class Status
        {
            public string Version;
            public bool ExtensionConnected;
            public int Pid;
        }

        /// <summary>连 named pipe，发一行 status 请求，读一行响应（约 1.5s 上限）。失败返回 null。</summary>
        internal static Status QueryStatus()
        {
            try
            {
                using (var pipe = new NamedPipeClientStream(".", Program.PipeName, PipeDirection.InOut))
                {
                    pipe.Connect(1000); // daemon 未跑 → TimeoutException → null（图标转未连接态）
                    var id = Guid.NewGuid().ToString();
                    var reqBytes = Encoding.UTF8.GetBytes(
                        "{\"id\":\"" + id + "\",\"method\":\"status\",\"params\":{}}\n");
                    pipe.Write(reqBytes, 0, reqBytes.Length);
                    pipe.Flush();

                    var line = ReadLine(pipe, 1500);
                    if (line == null) return null;

                    var root = Json.Deserialize<Dictionary<string, object>>(line);
                    if (root == null || !(root.ContainsKey("ok") && root["ok"] is bool && (bool)root["ok"]))
                        return null;
                    if (!(root.TryGetValue("result", out var r) && r is Dictionary<string, object> result))
                        return null;

                    return new Status
                    {
                        Version = result.TryGetValue("version", out var v) ? Convert.ToString(v) : "?",
                        ExtensionConnected = result.TryGetValue("extensionConnected", out var e)
                            && e is bool && (bool)e,
                        // pid 是加法字段：旧 daemon 不给 → 0（「退出」回落为仅退托盘，不 kill）。
                        Pid = result.TryGetValue("pid", out var p) && p != null
                            ? Convert.ToInt32(p, CultureInfo.InvariantCulture)
                            : 0,
                    };
                }
            }
            catch
            {
                return null;
            }
        }

        // named pipe 流不支持 ReadTimeout：把阻塞 Read 丢到线程池，用 Wait(timeout) 兜底。
        // 超时后 using 关闭 pipe 会让后台 Read 抛异常，ContinueWith 观测掉，避免 unobserved 崩溃。
        private static string ReadLine(Stream stream, int timeoutMs)
        {
            var task = Task.Run(() =>
            {
                var acc = new List<byte>();
                var buf = new byte[4096];
                while (true)
                {
                    int n = stream.Read(buf, 0, buf.Length);
                    if (n <= 0) break;
                    for (int i = 0; i < n; i++)
                    {
                        if (buf[i] == 0x0A) return Encoding.UTF8.GetString(acc.ToArray());
                        acc.Add(buf[i]);
                    }
                    if (acc.Count > 4_000_000) break;
                }
                return Encoding.UTF8.GetString(acc.ToArray());
            });
            task.ContinueWith(t => { _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            return task.Wait(timeoutMs) ? task.Result : null;
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);

        private readonly NotifyIcon _tray;
        private readonly Control _sync; // UI 线程 marshal 用（无可见窗口）
        private readonly System.Threading.Timer _poll;
        private IntPtr _iconHandle = IntPtr.Zero; // 当前 HICON（Icon.FromHandle 不持有，须手动 DestroyIcon）
        private Icon _iconObj; // 当前 Icon wrapper（随 HICON 一起换）
        private bool _connected;
        private bool _iconInitialized;
        private volatile bool _disposed;

        internal TrayContext()
        {
            // 隐藏 control 只为拿 UI 线程句柄做 BeginInvoke，从不显示。
            // 访问 .Handle 强制建句柄（未 parent 的 control CreateControl 不保证建句柄）。
            _sync = new Control();
            _ = _sync.Handle;

            var menu = new ContextMenuStrip();
            menu.Opening += OnMenuOpening;

            _tray = new NotifyIcon
            {
                Text = "Pie Link",
                ContextMenuStrip = menu,
                Visible = false,
            };
            ApplyIcon(false); // 起手未连接态，首个 poll 立刻纠正
            _tray.Visible = true; // 图标就位后再显示，避免空白托盘项

            // 轮询 status：daemon 起停时图标两态随之切换。查询在线程池，UI 更新 marshal 回主线程。
            _poll = new System.Threading.Timer(_ => Refresh(), null, 0, 3000);
        }

        private void Refresh()
        {
            if (_disposed) return;
            var status = DaemonClient.QueryStatus();
            var connected = status != null;
            if (_disposed) return;
            try
            {
                _sync.BeginInvoke((Action)(() =>
                {
                    if (_disposed) return;
                    ApplyIcon(connected);
                }));
            }
            catch (InvalidOperationException) { /* 句柄已随退出销毁 */ }
        }

        private void ApplyIcon(bool connected)
        {
            if (_iconInitialized && connected == _connected) return;
            _connected = connected;
            _iconInitialized = true;

            IntPtr oldHandle = _iconHandle;
            Icon oldObj = _iconObj;

            IntPtr h;
            using (var bmp = BuildBitmap(connected))
            {
                h = bmp.GetHicon();
            }
            _iconHandle = h;
            _iconObj = Icon.FromHandle(h);
            _tray.Icon = _iconObj;

            // 先切到新图标，再释放旧的：wrapper Dispose 不销毁 HICON，故显式 DestroyIcon。
            oldObj?.Dispose();
            if (oldHandle != IntPtr.Zero) DestroyIcon(oldHandle);
        }

        // 被咬一口的派（对齐 public/icons/icon-128.svg 与 mac pieTemplateIcon 的比例）。
        // 连接态 = 实心暖色派；未连接态 = 暗灰半透明派。咬口用 SourceCopy 挖真透明。
        private static Bitmap BuildBitmap(bool connected)
        {
            var bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                var fill = connected
                    ? Color.FromArgb(255, 0xE0, 0x8A, 0x2B) // 暖琥珀 = 已连接
                    : Color.FromArgb(110, 0x9A, 0x9A, 0x9A); // 暗灰半透明 = 未连接
                using (var brush = new SolidBrush(fill))
                    g.FillEllipse(brush, 4, 4, 24, 24); // 派 心(16,16) r12
                g.CompositingMode = CompositingMode.SourceCopy; // 覆盖为透明 = 真挖洞
                using (var clear = new SolidBrush(Color.Transparent))
                    g.FillEllipse(clear, 20, 1, 12, 12); // 咬口 右上
            }
            return bmp;
        }

        private void OnMenuOpening(object sender, System.ComponentModel.CancelEventArgs e)
        {
            var menu = (ContextMenuStrip)sender;
            menu.Items.Clear();

            // 点开菜单才查 daemon（fresh 一次），据此渲染状态行 + 同步图标态。
            var status = DaemonClient.QueryStatus();
            ApplyIcon(status != null);

            if (status != null)
            {
                menu.Items.Add(Disabled("Pie Link v" + status.Version + " · " + L10n.T("running")));
                menu.Items.Add(Disabled("    " + L10n.T(status.ExtensionConnected ? "extConnected" : "extDisconnected")));
            }
            else
            {
                menu.Items.Add(Disabled(L10n.T("notRunning")));
                menu.Items.Add(Disabled("    " + L10n.T("notResponding")));
            }

            menu.Items.Add(new ToolStripSeparator());

            var diagnostics = new ToolStripMenuItem(L10n.T("diagnostics"));
            diagnostics.Click += (_, __) => RunDoctor();
            menu.Items.Add(diagnostics);

            var repair = new ToolStripMenuItem(L10n.T("repairSandbox"));
            repair.Click += (_, __) => RepairSandbox();
            menu.Items.Add(repair);

            var openLogs = new ToolStripMenuItem(L10n.T("openLogs"));
            openLogs.Click += (_, __) => OpenLogsFolder();
            menu.Items.Add(openLogs);

            var quit = new ToolStripMenuItem(L10n.T("quit"));
            quit.Click += (_, __) => QuitPieLink(status);
            menu.Items.Add(quit);
        }

        private static ToolStripMenuItem Disabled(string text)
        {
            return new ToolStripMenuItem(text) { Enabled = false };
        }

        // 日志目录 = %USERPROFILE%\.pie\logs（对齐 daemon/src/paths.ts logsDir）。
        private static void OpenLogsFolder()
        {
            try
            {
                var dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pie", "logs");
                Directory.CreateDirectory(dir); // daemon 没跑过时目录可能不存在，先建再开免 explorer 报错
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
            }
            catch { /* best-effort */ }
        }

        // pie.exe 与 PieTray.exe 同目录（安装器把二者装进同一 app 目录）。
        private static string PieExePath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "pie.exe");
        }

        // 「诊断」= 跑 `pie.exe doctor` 抓 stdout+stderr，用 MessageBox 展示全文（原生 Ctrl+C 可复制）。
        // UseShellExecute=false + CreateNoWindow=true 抓管道且不闪黑框；exit 0 → 正常态，非 0 → 问题态。
        private void RunDoctor()
        {
            string output;
            int exitCode;
            try
            {
                var psi = new ProcessStartInfo(PieExePath(), "doctor")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var proc = Process.Start(psi))
                {
                    // 并发读两个管道，避免其一填满 buffer 时死锁（doctor 输出走 stderr，但两头都读稳妥）。
                    var stdoutTask = proc.StandardOutput.ReadToEndAsync();
                    var stderr = proc.StandardError.ReadToEnd();
                    var stdout = stdoutTask.GetAwaiter().GetResult();
                    proc.WaitForExit();
                    exitCode = proc.ExitCode;
                    output = (stdout + stderr).Trim();
                }
            }
            catch (Exception ex)
            {
                // pie.exe 缺失 / 无法启动：当问题态展示异常信息，别静默吞掉。
                output = ex.Message;
                exitCode = -1;
            }
            bool ok = exitCode == 0;
            if (output.Length == 0) output = ok ? "OK" : "(no output)";
            MessageBox.Show(output, L10n.T(ok ? "diagTitleOk" : "diagTitleProblem"),
                MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }

        // 「修复沙箱」= 提权依次跑 windows-uninstall + windows-install，跑完自动再诊断一次让用户看结果。
        // 必须两步：srt 幂等判定只看凭据在不在、不验能否登录，单跑 install 会「成功地什么都没修」（见 #400）。
        private void RepairSandbox()
        {
            // 第一步被取消（UAC 点否）则不继续第二步，也不再诊断——保持沙箱原状、不弹错。
            if (!RunElevated("windows-uninstall")) return;
            if (!RunElevated("windows-install")) return;
            RunDoctor();
        }

        // 提权跑 `pie.exe <arg>`：runas verb 必须走 ShellExecute；WindowStyle.Hidden 压掉控制台黑框。
        // 返回 false 仅当用户取消 UAC（NativeErrorCode 1223）——调用方据此中止后续步骤且不弹错、不诊断。
        // 其它失败返回 true：best-effort 不阻断，让流程继续，最终由随后的诊断展示真实状态。
        private static bool RunElevated(string arg)
        {
            try
            {
                var psi = new ProcessStartInfo(PieExePath(), arg)
                {
                    UseShellExecute = true, // runas 提权必须 ShellExecute（不能重定向管道）
                    Verb = "runas",
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                using (var proc = Process.Start(psi))
                {
                    if (proc != null) proc.WaitForExit();
                }
                return true;
            }
            catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
            {
                return false; // 用户取消 UAC：静默返回，中止链路
            }
            catch
            {
                return true; // 非取消失败：不阻断，交给随后的诊断显示实况
            }
        }

        // 「退出 Pie Link」= 关整套（对齐 mac Docker Desktop 模型）：先按 pid 结束 daemon，再退托盘。
        // 托盘因其它原因退出（注销 / 任务管理器）不走这里 → 不动 daemon（两进程独立）。
        private void QuitPieLink(DaemonClient.Status status)
        {
            var pid = status != null ? status.Pid : 0;
            if (pid <= 0)
            {
                // 菜单打开到点击之间 daemon 可能已变；补查一次 pid。
                var fresh = DaemonClient.QueryStatus();
                pid = fresh != null ? fresh.Pid : 0;
            }
            if (pid > 0)
            {
                try
                {
                    using (var proc = Process.GetProcessById(pid))
                        proc.Kill();
                }
                catch { /* 已退出 / 无权限：忽略，仍退托盘 */ }
            }
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _disposed = true;
                _poll?.Dispose();
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                }
                _iconObj?.Dispose();
                _iconObj = null;
                if (_iconHandle != IntPtr.Zero)
                {
                    DestroyIcon(_iconHandle);
                    _iconHandle = IntPtr.Zero;
                }
                _sync?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
