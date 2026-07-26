namespace MailToastHelper;

/// <summary>Extension methods for GDI+ drawing.</summary>
internal static class GraphicsExtensions
{
    private static readonly System.Drawing.Drawing2D.GraphicsPath _roundPath = new();

    public static void FillRoundedRect(this System.Drawing.Graphics g, Brush brush, Rectangle rect, int radius)
    {
        using var path = GetRoundedRect(rect, radius);
        g.FillPath(brush, path);
    }

    private static System.Drawing.Drawing2D.GraphicsPath GetRoundedRect(Rectangle rect, int r)
    {
        _roundPath.Reset();
        _roundPath.StartFigure();
        _roundPath.AddArc(rect.X, rect.Y, r, r, 180, 90);
        _roundPath.AddArc(rect.Right - r, rect.Y, r, r, 270, 90);
        _roundPath.AddArc(rect.Right - r, rect.Bottom - r, r, r, 0, 90);
        _roundPath.AddArc(rect.X, rect.Bottom - r, r, r, 90, 90);
        _roundPath.CloseFigure();
        return _roundPath;
    }
}
