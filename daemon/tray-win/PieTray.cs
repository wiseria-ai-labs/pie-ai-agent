// Pie Link Windows 托盘 app：`\\.\pipe\ai.wiseria.pie` 的瘦客户端。
// 对齐 mac 顶栏 app（daemon/menubar/main.swift）的收敛版：两态图标 + 三项菜单。
// 与 daemon 通信复用 status RPC（一问一答，一行 JSON 请求 / 一行 JSON 响应）。
// 编译：daemon/tray-win/build-tray.ps1（csc → net48 单 winexe，零运行时分发依赖）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Reflection;
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

        // 单实例守卫（#405）：装了开始菜单快捷方式后，用户可能连点两次入口。Run 键只在登录时起一次，
        // 撞不到；手动入口一撞就是两个托盘图标（且各自能点「退出 Pie Link」去 kill daemon）。mac 靠
        // Launch Services 天然单实例；Windows 得自己用命名 Mutex 做。Global\ 前缀 = 跨会话唯一（machine-wide
        // 安装语义一致），已在运行则第二个进程静默退出（用户从开始菜单点第二次的心智就是「打开它」，
        // 已经在托盘里就够了，弹「已在运行」提示框只是噪音）。
        private const string SingleInstanceMutexName = "Global\\ai.wiseria.pie.tray";

        [STAThread]
        private static void Main()
        {
            bool createdNew;
            Mutex mutex;
            // 进程存活期间持有 Mutex（不 Dispose / 不 ReleaseMutex）：进程退出时 OS 自动释放。
            try
            {
                mutex = new Mutex(true, SingleInstanceMutexName, out createdNew);
            }
            catch (UnauthorizedAccessException)
            {
                // 另一个登录会话已持有同名 Global\ mutex：.NET 默认 DACL 只授权 {SYSTEM, 创建者会话,
                // 创建者用户}，别的登录会话既建不了（已存在）也 open 不了（无匹配 ACE），CreateMutex 拿到
                // ACCESS_DENIED 后回落的 OpenMutex 同样被拒 → 抛异常。这仍是「已有托盘在跑」，按单实例
                // 语义静默退出，绝不能让未捕获异常把进程崩成 WER（多用户机器上第二个用户点开始菜单项即触发）。
                return;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // 同名已存在但类型/句柄不可打开：一并按「已在运行」处理。
                return;
            }

            using (mutex)
            {
                if (!createdNew) return; // 已有托盘在跑：静默退出，不抢占、不弹框。

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var ctx = new TrayContext())
                {
                    Application.Run(ctx);
                }
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
            var v = TOrNull(key);
            return v ?? key;
        }

        /// <summary>Like <see cref="T"/> but returns null for an unknown key (never the raw key).
        /// Used by the per-check doctor renderer so optional rows (status overrides / hints) can be
        /// skipped when a locale doesn't define them, instead of leaking "doctor.x.hint" text.</summary>
        internal static string TOrNull(string key)
        {
            if (Table.TryGetValue(key, out var row))
            {
                if (row.TryGetValue(Lang, out var v)) return v;
                if (row.TryGetValue("en", out var en)) return en;
            }
            return null;
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
                // --- Per-check doctor lines (#406). Titles keyed by the daemon's stable check id;
                // status words + "how to fix" hints looked up as doctor.<id>.<ok|bad|hint> with a
                // fallback to the generic doctor.statusOk / doctor.statusBad. daemon `detail` stays
                // raw English (never translated) and is appended verbatim under abnormal items.
                ["doctor.statusOk"] = new Dictionary<string, string>
                {
                    ["en"] = "OK", ["zh-CN"] = "正常", ["zh-TW"] = "正常",
                    ["ja"] = "正常", ["es-419"] = "Correcto", ["pt-BR"] = "Correto",
                },
                ["doctor.statusBad"] = new Dictionary<string, string>
                {
                    ["en"] = "Problem", ["zh-CN"] = "异常", ["zh-TW"] = "異常",
                    ["ja"] = "問題あり", ["es-419"] = "Problema", ["pt-BR"] = "Problema",
                },
                ["doctor.statusWarn"] = new Dictionary<string, string>
                {
                    ["en"] = "Notice", ["zh-CN"] = "注意", ["zh-TW"] = "注意",
                    ["ja"] = "注意", ["es-419"] = "Aviso", ["pt-BR"] = "Aviso",
                },
                ["doctor.nm_chrome"] = new Dictionary<string, string>
                {
                    ["en"] = "Browser connection (Chrome)", ["zh-CN"] = "浏览器连接（Chrome）",
                    ["zh-TW"] = "瀏覽器連線（Chrome）", ["ja"] = "ブラウザ接続（Chrome）",
                    ["es-419"] = "Conexión del navegador (Chrome)", ["pt-BR"] = "Conexão do navegador (Chrome)",
                },
                ["doctor.nm_chrome.hint"] = new Dictionary<string, string>
                {
                    ["en"] = "Reinstall Pie Link to restore the browser connection",
                    ["zh-CN"] = "重新安装 Pie Link 可恢复浏览器连接",
                    ["zh-TW"] = "重新安裝 Pie Link 可恢復瀏覽器連線",
                    ["ja"] = "Pie Link を再インストールすると接続が復旧します",
                    ["es-419"] = "Reinstala Pie Link para restaurar la conexión del navegador",
                    ["pt-BR"] = "Reinstale o Pie Link para restaurar a conexão do navegador",
                },
                ["doctor.nm_edge"] = new Dictionary<string, string>
                {
                    ["en"] = "Browser connection (Edge)", ["zh-CN"] = "浏览器连接（Edge）",
                    ["zh-TW"] = "瀏覽器連線（Edge）", ["ja"] = "ブラウザ接続（Edge）",
                    ["es-419"] = "Conexión del navegador (Edge)", ["pt-BR"] = "Conexão do navegador (Edge)",
                },
                ["doctor.nm_edge.hint"] = new Dictionary<string, string>
                {
                    ["en"] = "Reinstall Pie Link to restore the browser connection",
                    ["zh-CN"] = "重新安装 Pie Link 可恢复浏览器连接",
                    ["zh-TW"] = "重新安裝 Pie Link 可恢復瀏覽器連線",
                    ["ja"] = "Pie Link を再インストールすると接続が復旧します",
                    ["es-419"] = "Reinstala Pie Link para restaurar la conexión del navegador",
                    ["pt-BR"] = "Reinstale o Pie Link para restaurar a conexão do navegador",
                },
                ["doctor.sandbox"] = new Dictionary<string, string>
                {
                    ["en"] = "Script sandbox", ["zh-CN"] = "脚本沙箱", ["zh-TW"] = "指令碼沙箱",
                    ["ja"] = "スクリプトサンドボックス", ["es-419"] = "Sandbox de scripts",
                    ["pt-BR"] = "Sandbox de scripts",
                },
                ["doctor.sandbox.ok"] = new Dictionary<string, string>
                {
                    ["en"] = "Ready", ["zh-CN"] = "就绪", ["zh-TW"] = "就緒",
                    ["ja"] = "準備完了", ["es-419"] = "Listo", ["pt-BR"] = "Pronto",
                },
                ["doctor.sandbox.bad"] = new Dictionary<string, string>
                {
                    ["en"] = "Not ready", ["zh-CN"] = "未就绪", ["zh-TW"] = "未就緒",
                    ["ja"] = "未準備", ["es-419"] = "No está listo", ["pt-BR"] = "Não está pronto",
                },
                ["doctor.sandbox.hint"] = new Dictionary<string, string>
                {
                    ["en"] = "Click \"Repair Sandbox\" to fix it",
                    ["zh-CN"] = "点「修复沙箱」可以修好",
                    ["zh-TW"] = "點「修復沙箱」即可修復",
                    ["ja"] = "「サンドボックスを修復」をクリックすると修復できます",
                    ["es-419"] = "Haz clic en \"Reparar sandbox\" para solucionarlo",
                    ["pt-BR"] = "Clique em \"Reparar sandbox\" para corrigir",
                },
                ["doctor.install_path"] = new Dictionary<string, string>
                {
                    ["en"] = "Install location", ["zh-CN"] = "安装位置", ["zh-TW"] = "安裝位置",
                    ["ja"] = "インストール場所", ["es-419"] = "Ubicación de instalación",
                    ["pt-BR"] = "Local de instalação",
                },
                ["doctor.install_path.hint"] = new Dictionary<string, string>
                {
                    ["en"] = "Reinstall Pie Link to a local disk",
                    ["zh-CN"] = "把 Pie Link 重新安装到本地磁盘",
                    ["zh-TW"] = "將 Pie Link 重新安裝到本機磁碟",
                    ["ja"] = "Pie Link をローカルディスクに再インストールしてください",
                    ["es-419"] = "Reinstala Pie Link en un disco local",
                    ["pt-BR"] = "Reinstale o Pie Link em um disco local",
                },
                ["doctor.vc_runtime"] = new Dictionary<string, string>
                {
                    ["en"] = "Runtime library", ["zh-CN"] = "运行库", ["zh-TW"] = "執行庫",
                    ["ja"] = "ランタイムライブラリ", ["es-419"] = "Biblioteca de runtime",
                    ["pt-BR"] = "Biblioteca de runtime",
                },
                ["doctor.vc_runtime.ok"] = new Dictionary<string, string>
                {
                    ["en"] = "Installed", ["zh-CN"] = "已安装", ["zh-TW"] = "已安裝",
                    ["ja"] = "インストール済み", ["es-419"] = "Instalado", ["pt-BR"] = "Instalado",
                },
                ["doctor.vc_runtime.hint"] = new Dictionary<string, string>
                {
                    ["en"] = "Install the Microsoft Visual C++ x64 runtime",
                    ["zh-CN"] = "安装 Microsoft Visual C++ x64 运行库",
                    ["zh-TW"] = "安裝 Microsoft Visual C++ x64 執行庫",
                    ["ja"] = "Microsoft Visual C++ x64 ランタイムをインストールしてください",
                    ["es-419"] = "Instala el runtime de Microsoft Visual C++ x64",
                    ["pt-BR"] = "Instale o runtime do Microsoft Visual C++ x64",
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
                // #403：检查更新（Windows 走「下载 setup.exe → 覆盖安装，一次 UAC」，UAC 省不掉）
                ["checkForUpdates"] = new Dictionary<string, string>
                {
                    ["en"] = "Check for updates", ["zh-CN"] = "检查更新", ["zh-TW"] = "檢查更新",
                    ["ja"] = "更新を確認", ["es-419"] = "Buscar actualizaciones", ["pt-BR"] = "Verificar atualizações",
                },
                ["upToDate"] = new Dictionary<string, string>
                {
                    ["en"] = "Pie Link is up to date.", ["zh-CN"] = "Pie Link 已是最新版。", ["zh-TW"] = "Pie Link 已是最新版。",
                    ["ja"] = "Pie Link は最新です。", ["es-419"] = "Pie Link está actualizado.", ["pt-BR"] = "O Pie Link está atualizado.",
                },
                ["checkFailed"] = new Dictionary<string, string>
                {
                    ["en"] = "Couldn't check for updates.", ["zh-CN"] = "检查更新失败。", ["zh-TW"] = "檢查更新失敗。",
                    ["ja"] = "更新を確認できませんでした。", ["es-419"] = "No se pudo buscar actualizaciones.",
                    ["pt-BR"] = "Não foi possível verificar atualizações.",
                },
                ["updateTitle"] = new Dictionary<string, string>
                {
                    ["en"] = "Update Pie Link", ["zh-CN"] = "更新 Pie Link", ["zh-TW"] = "更新 Pie Link",
                    ["ja"] = "Pie Link を更新", ["es-419"] = "Actualizar Pie Link", ["pt-BR"] = "Atualizar Pie Link",
                },
                ["updatePrompt"] = new Dictionary<string, string>
                {
                    ["en"] = "A new version is available. Download and install it now?",
                    ["zh-CN"] = "有新版本可用。现在下载并安装吗？",
                    ["zh-TW"] = "有新版本可用。現在下載並安裝嗎？",
                    ["ja"] = "新しいバージョンがあります。今すぐダウンロードしてインストールしますか？",
                    ["es-419"] = "Hay una nueva versión disponible. ¿Descargar e instalar ahora?",
                    ["pt-BR"] = "Uma nova versão está disponível. Baixar e instalar agora?",
                },
                ["downloadFailed"] = new Dictionary<string, string>
                {
                    ["en"] = "Download failed.", ["zh-CN"] = "下载失败。", ["zh-TW"] = "下載失敗。",
                    ["ja"] = "ダウンロードに失敗しました。", ["es-419"] = "La descarga falló.", ["pt-BR"] = "Falha no download.",
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

    /// <summary>#403 Windows 更新：读同一份 pie-link-latest.json，有新版则下载 setup.exe 并运行
    /// （Inno 覆盖安装，一次 UAC）。UAC 在 Windows 省不掉，只优化「不知道有新版 / 找不到下载」。</summary>
    internal static class Updater
    {
        // 与 daemon/src/update.ts 同一固定 URL + 同一白名单前缀（下载物 URL 必须以它开头）。
        internal const string LatestJsonUrl =
            "https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link-latest.json";
        internal const string ReleasesUrlPrefix = "https://github.com/WiseriaAI/pie-ai-agent/releases/";

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        internal sealed class Latest { public string Version; public string Url; public string Sha256; }

        /// <summary>三段 semver 比较（与扩展侧 compareDaemonVersions / update.ts compareVersions 同语义）。</summary>
        internal static int CompareVersions(string a, string b)
        {
            var pa = ParseTriplet(a);
            var pb = ParseTriplet(b);
            for (int i = 0; i < 3; i++)
            {
                int d = pa[i] - pb[i];
                if (d != 0) return d < 0 ? -1 : 1;
            }
            return 0;
        }

        private static int[] ParseTriplet(string v)
        {
            var parts = (v ?? "").Split('.');
            var r = new int[3];
            for (int i = 0; i < 3; i++)
            {
                int n;
                r[i] = i < parts.Length && int.TryParse(parts[i], out n) ? n : 0;
            }
            return r;
        }

        /// <summary>GET latest.json，解析出 windows 平台的 url/sha256/version。失败返回 null。</summary>
        internal static Latest FetchLatest()
        {
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; // GitHub 要 TLS 1.2
                using (var wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "PieLinkTray");
                    var body = wc.DownloadString(LatestJsonUrl);
                    var root = Json.Deserialize<Dictionary<string, object>>(body);
                    if (root == null) return null;
                    string version = root.TryGetValue("version", out var v) ? Convert.ToString(v) : null;
                    if (!(root.TryGetValue("windows", out var w) && w is Dictionary<string, object> win)) return null;
                    string url = win.TryGetValue("url", out var u) ? Convert.ToString(u) : null;
                    string sha = win.TryGetValue("sha256", out var s) ? Convert.ToString(s) : null;
                    if (string.IsNullOrEmpty(version) || string.IsNullOrEmpty(url)) return null;
                    return new Latest { Version = version, Url = url, Sha256 = sha };
                }
            }
            catch { return null; }
        }

        /// <summary>下载 setup.exe 到临时目录并返回路径；URL 白名单 + sha256 校验，任一不过返回 null。</summary>
        internal static string DownloadInstaller(Latest latest)
        {
            try
            {
                if (latest.Url == null || !latest.Url.StartsWith(ReleasesUrlPrefix, StringComparison.Ordinal)) return null;
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                var dest = Path.Combine(Path.GetTempPath(), "pie-link-setup-" + latest.Version + ".exe");
                using (var wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "PieLinkTray");
                    wc.DownloadFile(latest.Url, dest);
                }
                if (!string.IsNullOrEmpty(latest.Sha256) && !Sha256Matches(dest, latest.Sha256)) return null;
                return dest;
            }
            catch { return null; }
        }

        private static bool Sha256Matches(string path, string expectedHex)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var fs = File.OpenRead(path))
            {
                var hash = sha.ComputeHash(fs);
                var hex = BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
                return string.Equals(hex, expectedHex.Trim().ToLowerInvariant(), StringComparison.Ordinal);
            }
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

        // 品牌图标（对齐 public/icons/icon-128.svg：深圆角底板 + 白派 + 右上咬口），从嵌入的多档
        // pie.ico 取 32 档画进 32×32 ARGB bitmap。底板保留——纯白派在浅色任务栏上会消失，咬口本就是
        // 底板色实心，底板在则咬口自然成立，无需挖透明。连接态原色；未连接态整体压 alpha 到 40%
        // （这份资产近乎无彩色，去饱和无效，只能压透明度）。
        //
        // 固定取 32 档而非 SystemInformation.SmallIconSize：NotifyIcon 交给 shell 的是 HICON，由
        // explorer.exe（per-monitor DPI aware）按需绘制，不经本进程 DPI 虚拟化；PieTray.exe 是
        // DPI-unaware 进程，SmallIconSize 只返回虚拟化后的 16×16 反而选错档。给 32 让 explorer 在
        // 100% 下 downsample、200% 下正好。若 200% 真机仍糊，把取档尺寸改成 48（ico 内已有 48 档）。
        private static Bitmap BuildBitmap(bool connected)
        {
            var bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb);
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("pie.ico"))
            using (var icon = new Icon(stream, new Size(32, 32)))
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                if (connected)
                {
                    g.DrawIcon(icon, new Rectangle(0, 0, 32, 32));
                }
                else
                {
                    // ColorMatrix Matrix33 = 整体 alpha 乘子，把不透明像素压到 40% 做「变淡」态。
                    using (var src = icon.ToBitmap())
                    using (var attrs = new ImageAttributes())
                    {
                        var matrix = new ColorMatrix { Matrix33 = 0.4f };
                        attrs.SetColorMatrix(matrix);
                        g.DrawImage(src, new Rectangle(0, 0, 32, 32),
                            0, 0, src.Width, src.Height, GraphicsUnit.Pixel, attrs);
                    }
                }
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

            var checkUpdate = new ToolStripMenuItem(L10n.T("checkForUpdates"));
            checkUpdate.Click += (_, __) => CheckForUpdates(status);
            menu.Items.Add(checkUpdate);

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

        // 「诊断」= 跑 `pie.exe doctor --json`，把结构化 checks 渲染成人话逐项展示（#406）。
        // JSON 走 stdout，人类可读全文走 stderr（互不混）；解析成功就按项渲染，失败回落到全文（问题态）。
        private void RunDoctor()
        {
            string stdout, stderr;
            int exitCode;
            try
            {
                var psi = new ProcessStartInfo(PieExePath(), "doctor --json")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    // pie.exe 输出 UTF-8；不显式指定则 .NET Framework 按系统 ANSI 代码页（zh-CN=GBK）解码，
                    // 会把 em dash 等非 ASCII 读成乱码（`鈥?`），废掉 detail 的截图/复制排障用途。
                    StandardOutputEncoding = new UTF8Encoding(false),
                    StandardErrorEncoding = new UTF8Encoding(false),
                };
                using (var proc = Process.Start(psi))
                {
                    // 并发读两个管道，避免其一填满 buffer 时死锁（JSON→stdout，全文→stderr）。
                    var stdoutTask = proc.StandardOutput.ReadToEndAsync();
                    stderr = proc.StandardError.ReadToEnd();
                    stdout = stdoutTask.GetAwaiter().GetResult();
                    proc.WaitForExit();
                    exitCode = proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                // pie.exe 缺失 / 无法启动：当问题态展示异常信息，别静默吞掉。
                MessageBox.Show(ex.Message, L10n.T("diagTitleProblem"),
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var checks = DoctorJson.ParseChecks(stdout);
            if (checks == null || checks.Count == 0)
            {
                // JSON 解析失败 / 没有 checks（非 Windows daemon 或旧版）：回落到原始全文 + 问题态。
                var raw = (stdout + stderr).Trim();
                if (raw.Length == 0) raw = "(no output)";
                MessageBox.Show(raw, L10n.T("diagTitleProblem"),
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            RenderChecks(checks);
        }

        // DoctorCheck 类型与 `pie doctor --json` 的解析已抽到 DoctorJson.cs（不依赖 WinForms/L10n），
        // 好让 DoctorJsonSmoke.cs 控制台冒烟测试用真 .NET Framework JavaScriptSerializer 覆盖它——
        // ArrayList vs object[] 的坑（#408 review F1）只在真机 .NET 重现，此前 C# 解析层零覆盖。

        // 按项渲染：异常项排最前；每项一行「{图标} {人话标题}：{状态词}」，异常项下补「怎么办」+ 原始 detail。
        // 标题：任一 error → 问题态（Warning）；否则正常态（Information）。warn 显示为提示但不翻标题（#406）。
        private static void RenderChecks(List<DoctorCheck> checks)
        {
            // error 排前、warn 次之、ok 最后；同级保持 daemon 给出的原顺序（稳定排序）。
            var ordered = new List<DoctorCheck>();
            foreach (var s in new[] { "error", "warn", "ok" })
                foreach (var c in checks)
                    if (string.Equals(c.Status, s, StringComparison.OrdinalIgnoreCase))
                        ordered.Add(c);
            // 未知 status 的项兜底收尾，避免被吞掉。
            foreach (var c in checks)
                if (!ordered.Contains(c)) ordered.Add(c);

            bool anyError = false;
            var sb = new StringBuilder();
            foreach (var c in ordered)
            {
                bool isError = string.Equals(c.Status, "error", StringComparison.OrdinalIgnoreCase);
                bool isOk = string.Equals(c.Status, "ok", StringComparison.OrdinalIgnoreCase);
                if (isError) anyError = true;

                string icon = isOk ? "✓" : "⚠";
                string title = L10n.TOrNull("doctor." + c.Id) ?? c.Id; // 未知 id 兜底显示原始 key
                string statusWord = StatusWord(c.Id, c.Status);
                sb.AppendLine(icon + " " + title + LabelSep() + statusWord);

                if (!isOk)
                {
                    var hint = L10n.TOrNull("doctor." + c.Id + ".hint");
                    if (!string.IsNullOrEmpty(hint)) sb.AppendLine("    " + hint);
                    if (!string.IsNullOrEmpty(c.Detail)) sb.AppendLine("    " + c.Detail);
                }
            }

            MessageBox.Show(
                sb.ToString().TrimEnd(),
                L10n.T(anyError ? "diagTitleProblem" : "diagTitleOk"),
                MessageBoxButtons.OK,
                anyError ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
        }

        // 「标题—状态词」分隔符：CJK locale 用全角「：」，西文 locale 用半角「: 」（避免 `Install location：OK` 的突兀排版）。
        private static string LabelSep()
        {
            switch (L10n.Lang)
            {
                case "zh-CN":
                case "zh-TW":
                case "ja":
                    return "：";
                default:
                    return ": ";
            }
        }

        // 状态词：优先按 id 取覆盖（如 sandbox.bad=「未就绪」、vc_runtime.ok=「已安装」），否则回落通用词。
        private static string StatusWord(string id, string status)
        {
            bool isOk = string.Equals(status, "ok", StringComparison.OrdinalIgnoreCase);
            bool isWarn = string.Equals(status, "warn", StringComparison.OrdinalIgnoreCase);
            var perId = L10n.TOrNull("doctor." + id + "." + (isOk ? "ok" : "bad"));
            if (perId != null) return perId;
            if (isOk) return L10n.T("doctor.statusOk");
            if (isWarn) return L10n.T("doctor.statusWarn");
            return L10n.T("doctor.statusBad");
        }

        // #403「检查更新」= 读 pie-link-latest.json，与当前版本比较；有新版则下载 setup.exe（URL 白名单
        // + sha256 校验）并运行（Inno 覆盖安装，一次 UAC）。UAC 在 Windows 省不掉，daemon 自更新不走这条。
        private void CheckForUpdates(DaemonClient.Status status)
        {
            var latest = Updater.FetchLatest();
            if (latest == null)
            {
                MessageBox.Show(L10n.T("checkFailed"), L10n.T("updateTitle"),
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            // 当前版本未知（daemon 没跑）时也允许更新——把它当作「比任何版本都旧」处理。
            var current = status != null ? status.Version : "0.0.0";
            if (Updater.CompareVersions(latest.Version, current) <= 0)
            {
                MessageBox.Show(L10n.T("upToDate"), L10n.T("updateTitle"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var answer = MessageBox.Show(
                L10n.T("updatePrompt") + "\n\nv" + current + " → v" + latest.Version,
                L10n.T("updateTitle"), MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;

            var installer = Updater.DownloadInstaller(latest);
            if (installer == null)
            {
                MessageBox.Show(L10n.T("downloadFailed"), L10n.T("updateTitle"),
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                // ShellExecute 运行签名安装器 → Inno 弹一次 UAC 覆盖安装（signed exe，SmartScreen 认得）。
                Process.Start(new ProcessStartInfo(installer) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, L10n.T("updateTitle"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
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
