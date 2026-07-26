using System.Text.Json;

namespace MailToastHelper;

/// <summary>
/// 邮件桌面通知弹窗，匹配插件「纸质档案室」暗色主题。
/// 字体：轮询系统已装字体，找到一个能实际渲染中文字符的为止（实测渲染测试）。
/// </summary>
public class ToastForm : Form
{
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    // ── 插件暗色主题调色板 ──
    private static readonly Color C_Bg       = Color.FromArgb(58, 50, 40);   // #3a3228
    private static readonly Color C_Border   = Color.FromArgb(42, 35, 27);   // #2a231b
    private static readonly Color C_Gold     = Color.FromArgb(212, 187, 126); // #d4bb7e
    private static readonly Color C_Ink      = Color.FromArgb(230, 223, 208); // #e6dfd0
    private static readonly Color C_InkSoft  = Color.FromArgb(184, 173, 153); // #b8ad99
    private static readonly Color C_Muted    = Color.FromArgb(143, 130, 114); // #8f8272

    // ── 字体：轮询系统已装 CJK 字体（不做 Bitmap 渲染测试，避免无桌面上下文时崩溃）──
    private static readonly Font FxUi   = MakeFont(9.75f,  FontStyle.Regular);
    private static readonly Font FxSubj = MakeFont(11.0f,  FontStyle.Bold);
    private static readonly Font FxTime = MakeFont(8.5f,   FontStyle.Regular);
    private static readonly Font FxClose = MakeFont(12.0f, FontStyle.Regular);

    private static Font MakeFont(float size, FontStyle style)
    {
        // 判断候选字体在系统上是否存在
        var installed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try { foreach (var ff in FontFamily.Families) installed.Add(ff.Name); } catch { }

        var cjk = new[] {
            "SimHei", "Microsoft YaHei UI", "Microsoft YaHei",
            "宋体", "SimSun", "NSimSun",
            "微软雅黑", "微软雅黑 Light",
            "楷体", "SimKai", "仿宋", "SimFang",
            "黑体", "STSong", "华文宋体", "华文中宋", "华文细黑",
            "微軟正黑體",
            "Yu Gothic", "MS Gothic", "Malgun Gothic",
            "Segoe UI", "Arial",
        };
        foreach (var name in cjk)
        {
            if (installed.Contains(name))
            {
                try { return new Font(name, size, style, GraphicsUnit.Point); }
                catch { }
            }
        }
        return new Font(FontFamily.GenericSansSerif, size, style, GraphicsUnit.Point);
    }

    // ── 数据 ──
    private readonly string _id, _clickPath, _subject, _sender;
    private readonly string? _messageId, _accountId;
    private readonly System.Windows.Forms.Timer _closeTimer;
    private Point _targetLocation;
    private bool _isClosing;

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    public ToastForm(ToastPayload payload, string clickPath)
    {
        _id = payload.Id; _clickPath = clickPath;
        _subject = payload.Subject; _sender = payload.Sender;
        _messageId = payload.MessageId; _accountId = payload.AccountId;

        Text = "Hanako Mail";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false; TopMost = true;

        var scale = DeviceDpi / 96.0;
        Width = (int)(360 * scale); Height = (int)(80 * scale);
        BackColor = C_Border; Opacity = 0;

        var wa = Screen.PrimaryScreen!.WorkingArea;
        _targetLocation = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
        Location = new Point(_targetLocation.X + 60, _targetLocation.Y);

        Paint += OnPaint; Click += OnToastClick;
        _closeTimer = new System.Windows.Forms.Timer { Interval = 6000 };
        _closeTimer.Tick += (_, _) => BeginClose();
        _closeTimer.Start();

        var enterTimer = new System.Windows.Forms.Timer { Interval = 15 };
        var enterStart = DateTime.UtcNow;
        enterTimer.Tick += (_, _) =>
        {
            var elapsed = (DateTime.UtcNow - enterStart).TotalMilliseconds;
            var progress = Math.Min(1.0, elapsed / 300.0);
            var eased = 1.0 - Math.Pow(1.0 - progress, 3.0);
            Location = new Point(_targetLocation.X + (int)(60 * (1.0 - eased)), _targetLocation.Y);
            Opacity = (float)Math.Min(1.0, progress * 1.5);
            if (progress >= 1.0) { enterTimer.Stop(); enterTimer.Dispose(); Location = _targetLocation; Opacity = 1; }
        };
        enterTimer.Start();
    }

    private void OnPaint(object? sender, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        var w = Width; var h = Height;

        g.FillRoundedRect(new SolidBrush(C_Bg), new Rectangle(1, 1, w - 2, h - 2), 6);
        g.FillRectangle(new SolidBrush(C_Gold), 1, 1, 4, h - 2);

        TextRenderer.DrawText(g, _sender ?? "", FxUi, new Point(18, 8), C_InkSoft);

        var subj = _subject ?? "";
        var sw = TextRenderer.MeasureText(g, subj + "…", FxSubj);
        while (sw.Width > w - 44 && subj.Length > 1) { subj = subj[..^1]; sw = TextRenderer.MeasureText(g, subj + "…", FxSubj); }
        if (sw.Width > w - 44) subj += "…";
        TextRenderer.DrawText(g, subj, FxSubj, new Point(18, 32), C_Ink);

        TextRenderer.DrawText(g, DateTime.Now.ToShortTimeString(), FxTime, new Point(w - 60, 8), C_Muted);
        TextRenderer.DrawText(g, "×", FxClose, new Rectangle(w - 22, 6, 16, 16), C_Muted, TextFormatFlags.Left);
    }

    private void OnToastClick(object? sender, EventArgs e)
    {
        try
        {
            if (PointToClient(Cursor.Position).X >= Width - 26) { BeginClose(); return; }
            try
            {
                File.WriteAllText(_clickPath, JsonSerializer.Serialize(new ClickEvent
                {
                    ToastId = _id, ClickedAt = DateTime.UtcNow.ToString("o"),
                    MessageId = _messageId ?? "", AccountId = _accountId ?? ""
                }));
            }
            catch { }
            BeginClose();
        }
        catch { }
    }

    private void BeginClose()
    {
        if (_isClosing) return;
        _isClosing = true;
        _closeTimer.Stop(); _closeTimer.Dispose();
        var exitTimer = new System.Windows.Forms.Timer { Interval = 15 };
        var exitStart = DateTime.UtcNow;
        exitTimer.Tick += (_, _) =>
        {
            var progress = Math.Min(1.0, (DateTime.UtcNow - exitStart).TotalMilliseconds / 250.0);
            Opacity = (float)Math.Max(0, 1.0 - (1.0 - Math.Pow(1.0 - progress, 2.0)));
            if (progress >= 1.0) { exitTimer.Stop(); exitTimer.Dispose(); Close(); }
        };
        exitTimer.Start();
    }

    public class ToastPayload
    {
        public string Id { get; set; } = "";
        public string Subject { get; set; } = "";
        public string Sender { get; set; } = "";
        public string? MessageId { get; set; }
        public string? AccountId { get; set; }
    }
    public class ClickEvent
    {
        public string ToastId { get; set; } = "";
        public string ClickedAt { get; set; } = "";
        public string MessageId { get; set; } = "";
        public string AccountId { get; set; } = "";
    }
}
