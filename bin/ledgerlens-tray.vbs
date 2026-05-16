' Ledgerlens silent tray launcher.
' Spawns the PowerShell tray host with NO console window at all.
' Resolves the current version dir from %LOCALAPPDATA%\ledgerlens\current.json
' so it always invokes the latest installed tray.ps1.

Option Explicit

Dim shell, fso, installDir, curPath, raw, json, versionPath, trayPs1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

installDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\ledgerlens")
curPath    = installDir & "\current.json"

If Not fso.FileExists(curPath) Then
    MsgBox "Ledgerlens is not installed. Reinstall from https://adityavaish.github.io/ledgerlens/", _
           vbExclamation, "Ledgerlens"
    WScript.Quit 1
End If

' Tiny JSON-ish path extraction. The file is written by us in a known
' shape, so regex on "path": "<value>" is sufficient and avoids a
' dependency on a JSON parser inside cscript.
' Read current.json as UTF-8. VBScript's FileSystemObject can only do
' ASCII or UTF-16, but our installer writes UTF-8 (without BOM). Use
' ADODB.Stream which supports an explicit charset.
Dim stream
Set stream = CreateObject("ADODB.Stream")
stream.Type = 2          ' adTypeText
stream.Charset = "utf-8"
stream.Open
stream.LoadFromFile curPath
raw = stream.ReadText
stream.Close

Dim re, m
Set re = New RegExp
re.Pattern    = """path""\s*:\s*""([^""]+)"""
re.IgnoreCase = True
If Not re.Test(raw) Then
    MsgBox "Could not find current Ledgerlens install path in " & curPath, _
           vbExclamation, "Ledgerlens"
    WScript.Quit 1
End If
Set m = re.Execute(raw)
versionPath = m(0).SubMatches(0)
versionPath = Replace(versionPath, "\\", "\")

trayPs1 = versionPath & "\bin\tray.ps1"
If Not fso.FileExists(trayPs1) Then
    MsgBox "Ledgerlens tray script not found: " & trayPs1, vbExclamation, "Ledgerlens"
    WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayPs1 & """"
' Last argument 0 = SW_HIDE, false = don't wait. wscript itself shows no
' window, so the launched powershell is fully invisible.
shell.Run cmd, 0, False