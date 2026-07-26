' click.vbs — 无窗口 VBS 脚本，将 sidecar JSON 拷贝到点击目标文件
' 用法: wscript.exe click.vbs <source.json> <dest.json>
' 这样 SnoreToast 的 -click/-close 回调不会弹出控制台窗口

Option Explicit
Dim fso, src, dst
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count >= 2 Then
    src = WScript.Arguments(0)
    dst = WScript.Arguments(1)
    If fso.FileExists(src) Then
        fso.CopyFile src, dst, True
    End If
End If
