// 一次性诊断：dump 系统所有可用字体到 stdout
using System.Text;

FontFamily[] families = System.Drawing.FontFamily.Families;
var sb = new StringBuilder();
sb.AppendLine($"Total families: {families.Length}");
sb.AppendLine("---ALL---");
foreach (var f in families.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
{
    var installed = f.IsStyleAvailable(FontStyle.Regular) ? "R" : "";
    var installedB = f.IsStyleAvailable(FontStyle.Bold) ? "B" : "";
    sb.AppendLine($"{installed}{installedB} {f.Name}");
}
File.WriteAllText(@"C:\Users\USERNAME\AppData\Local\Temp\hanako-fonts.txt", sb.ToString(), Encoding.UTF8);