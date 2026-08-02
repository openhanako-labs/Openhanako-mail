using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace MailToastHelper;

/// <summary>
/// Entry point for the Mail Toast Helper.
///
/// Mode 1 — TCP Server:
///   mail-toast-helper --port 48105 [--clickdir <path>]
///   Listens for JSON commands over TCP: {"t":"create","id":"...","subject":"...","sender":"...","messageId":"...","accountId":"..."}
///
/// Mode 2 — One-shot via args file:
///   mail-toast-helper --oneshot --args-file <json-file-path>
///   Reads payload from a JSON file (UTF-8) — avoids ANSI conversion of Unicode through process arguments.
///
/// Mode 3 — One-shot via stdin:
///   echo '{"t":"create","subject":"桌面弹窗"}' | mail-toast-helper --oneshot --stdin
///   Reads JSON payload from stdin (UTF-8).
/// </summary>
internal static class Program
{
    private static string? s_clickDir;
    // 临时目录统一走系统 Temp（原硬编码本机用户 Temp 绝对路径，不可移植，已移除）
    private static readonly string s_tempDir = Path.GetTempPath();
    private static readonly string s_logPath = Path.Combine(s_tempDir, "hanako-helper.log");
    private static readonly string s_errPath = Path.Combine(s_tempDir, "hanako-helper-error.txt");
    private static readonly string s_fontsPath = Path.Combine(s_tempDir, "hanako-fonts.txt");

    [STAThread]
    private static void Main(string[] args)
    {
        // 用 GDI（Uniscribe）处理字体回退——支持 CJK 自动回退到系统已装的 CJK 字体
        Application.SetCompatibleTextRenderingDefault(false);
        // 高 DPI 支持
        Application.SetHighDpiMode(System.Windows.Forms.HighDpiMode.SystemAware);

        // 诊断模式 — 会写日志确保知道 helper 被调用了
        if (Array.IndexOf(args, "--dump-fonts") >= 0) { DumpFonts(); return; }

        // 调试日志
        try { File.AppendAllText(s_logPath,
            $"[{DateTime.Now:HH:mm:ss}] Started with args: {string.Join(" ", args)}\n"); } catch { }

        string? portStr = null;
        string? clickDirOverride = null;
        bool oneShot = false;
        bool readStdin = false;
        string? argsFile = null;
        // Raw arg parsing for one-shot
        string? rawSubj = null, rawSender = null, rawMsgId = null, rawAcctId = null;
        string? rawId = null;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length) portStr = args[++i];
            if (args[i] == "--clickdir" && i + 1 < args.Length) clickDirOverride = args[++i];
            if (args[i] == "--oneshot") oneShot = true;
            if (args[i] == "--stdin") readStdin = true;
            if (args[i] == "--args-file" && i + 1 < args.Length) argsFile = args[++i];

            if (oneShot && i + 1 < args.Length)
            {
                var next = args[i + 1];
                if (args[i] == "--subject" && next != null && !next.StartsWith("--")) rawSubj = next;
                else if (args[i] == "--sender" && next != null && !next.StartsWith("--")) rawSender = next;
                else if (args[i] == "--messageId") rawMsgId = next;
                else if (args[i] == "--accountId") rawAcctId = next;
                else if (args[i] == "--id") rawId = next;
            }
            // Consume value flag
            if ((args[i] == "--subject" || args[i] == "--sender" || args[i] == "--messageId" || args[i] == "--accountId" || args[i] == "--id") && i + 1 < args.Length)
                i++;
        }

        s_clickDir = clickDirOverride ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Hanako", "mail-toast-helper");
        Directory.CreateDirectory(s_clickDir);

        if (oneShot)
        {
            try
            {
                // ── 解析 payload ──
                ToastForm.ToastPayload payload;

                if (!string.IsNullOrEmpty(argsFile) && File.Exists(argsFile))
                {
                    var json = File.ReadAllText(argsFile);
                    payload = JsonSerializer.Deserialize<ToastForm.ToastPayload>(json, new JsonSerializerOptions
                    {
                        PropertyNameCaseInsensitive = true
                    }) ?? new ToastForm.ToastPayload();
                    try { File.Delete(argsFile); } catch { }
                }
                else if (readStdin)
                {
                    Console.InputEncoding = Encoding.UTF8;
                    var json = Console.In.ReadToEnd();
                    payload = JsonSerializer.Deserialize<ToastForm.ToastPayload>(json, new JsonSerializerOptions
                    {
                        PropertyNameCaseInsensitive = true
                    }) ?? new ToastForm.ToastPayload();
                }
                else
                {
                    payload = new ToastForm.ToastPayload
                    {
                        Id = rawId ?? Guid.NewGuid().ToString("N")[..12],
                        Subject = rawSubj ?? "",
                        Sender = rawSender ?? "",
                        MessageId = rawMsgId ?? "",
                        AccountId = rawAcctId ?? ""
                    };
                }

                var id = string.IsNullOrEmpty(payload.Id) ? Guid.NewGuid().ToString("N")[..12] : payload.Id;
                var clickPath = Path.Combine(s_clickDir, $"{id}.click.json");

                Log($"Showing toast: subject={payload.Subject} sender={payload.Sender}");
                var form = new ToastForm(payload, clickPath);
                form.Shown += (_, _) => Log("Toast shown");
                form.FormClosed += (_, _) => Log("Toast closed");
                Application.Run(form);
                Log("Application.Run() exited normally");
            }
            catch (Exception ex)
            {
                Log($"Oneshot failed: {ex.Message}\n{ex.StackTrace}");
                try { File.WriteAllText(s_errPath, ex.ToString()); } catch { }
            }
            return;
        }

        // TCP Server mode (long-running)
        int port = int.TryParse(portStr, out var p) ? p : 48105;
        var hiddenWindow = new Form();
        hiddenWindow.WindowState = FormWindowState.Minimized;
        hiddenWindow.ShowInTaskbar = false;
        hiddenWindow.Load += (_, _) => { hiddenWindow.WindowState = FormWindowState.Minimized; hiddenWindow.Hide(); };

        var tcpThread = new Thread(() => RunTcpServer(port, hiddenWindow))
        {
            IsBackground = true, Name = "TcpServer"
        };
        tcpThread.Start();
        Application.Run(hiddenWindow);
    }

    private static void Log(string msg)
    {
        try { File.AppendAllText(s_logPath, $"[{DateTime.Now:HH:mm:ss}] {msg}\n"); }
        catch { }
    }

    private static void RunTcpServer(int port, Form hiddenWindow)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();

        while (true)
        {
            try
            {
                using var client = listener.AcceptTcpClient();
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.UTF8);
                using var writer = new StreamWriter(stream, Encoding.UTF8);

                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    var response = HandleCommand(line, hiddenWindow);
                    writer.WriteLine(response);
                    writer.Flush();
                }
            }
            catch (ObjectDisposedException) { break; }
            catch { /* keep listening */ }
        }
    }

    private static string HandleCommand(string json, Form hiddenWindow)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var type = root.GetProperty("t").GetString();

            switch (type)
            {
                case "create":
                    return HandleCreate(root, hiddenWindow);
                case "ping":
                    return JsonSerializer.Serialize(new { t = "pong", id = root.GetProperty("id").GetString() ?? "" });
                default:
                    return JsonSerializer.Serialize(new { t = "nack", id = "", error = $"unknown type: {type}" });
            }
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new { t = "nack", id = "", error = ex.Message });
        }
    }

    private static string HandleCreate(JsonElement root, Form hiddenWindow)
    {
        var id = root.GetProperty("id").GetString() ?? Guid.NewGuid().ToString("N");
        var payload = new ToastForm.ToastPayload
        {
            Id = id,
            Subject = root.GetProperty("subject").GetString() ?? "",
            Sender = root.GetProperty("sender").GetString() ?? "",
            MessageId = root.TryGetProperty("messageId", out var mid) ? mid.GetString() : null,
            AccountId = root.TryGetProperty("accountId", out var aid) ? aid.GetString() : null,
        };

        var clickPath = Path.Combine(s_clickDir!, $"{id}.click.json");

        // Show the toast on the UI thread (via the hidden message pump anchor)
        hiddenWindow.BeginInvoke(() =>
        {
            var toast = new ToastForm(payload, clickPath);
            toast.Show();
        });

        return JsonSerializer.Serialize(new { t = "ack", id, ok = true, op = "queued" });
    }

    private static void DumpFonts()
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"Total: {FontFamily.Families.Length}");
        foreach (var f in FontFamily.Families.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
        {
            var r = f.IsStyleAvailable(FontStyle.Regular) ? "R" : "";
            var b = f.IsStyleAvailable(FontStyle.Bold) ? "B" : "";
            sb.AppendLine($"{r}{b} {f.Name}");
        }
        File.WriteAllText(s_fontsPath, sb.ToString());
    }
}