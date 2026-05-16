# Ledgerlens — system-tray host (Windows).
#
# Spawns `node bin\ledgerlens.js` as a hidden child process and surfaces
# the local server through a system-tray icon. Menu items:
#
#   * Open Excel
#   * Open chat (browser)
#   * Show logs
#   * About
#   * Stop Ledgerlens
#
# Run via the .cmd shim:  ledgerlens-tray.cmd
# That shim uses `powershell -WindowStyle Hidden` so no console is shown.

param(
    [string]$VersionDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─── Paths ───────────────────────────────────────────────────────────────
$installDir = if ($env:LEDGERLENS_HOME) {
    $env:LEDGERLENS_HOME
} elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'ledgerlens'
} else {
    Join-Path $HOME '.ledgerlens'
}
$logDir = Join-Path $installDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("ledgerlens-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

# Resolve current version dir from current.json so the tray host always
# launches whatever the auto-updater most recently installed.
function Get-CurrentVersionDir {
    $curPath = Join-Path $installDir 'current.json'
    if (Test-Path $curPath) {
        try {
            $raw = Get-Content $curPath -Raw
            if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
            $cur = $raw | ConvertFrom-Json
            if ($cur.path -and (Test-Path (Join-Path $cur.path 'bin\ledgerlens.js'))) {
                return $cur.path
            }
        } catch {}
    }
    if (Test-Path (Join-Path $VersionDir '..\bin\ledgerlens.js')) {
        return (Resolve-Path (Join-Path $VersionDir '..')).Path
    }
    return $null
}

$runDir = Get-CurrentVersionDir
if (-not $runDir) {
    [System.Windows.Forms.MessageBox]::Show(
        "Ledgerlens is not installed correctly. Reinstall from https://adityavaish.github.io/ledgerlens/",
        "Ledgerlens", 'OK', 'Error'
    ) | Out-Null
    exit 1
}
$launcherJs = Join-Path $runDir 'bin\ledgerlens.js'

# ─── Spawn the launcher as a hidden child process ────────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = 'node.exe'
$psi.Arguments              = "`"$launcherJs`""
$psi.WorkingDirectory       = $runDir
$psi.UseShellExecute        = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.CreateNoWindow         = $true

# Append-only log file. The async Process events run in PowerShell's
# background runspace which can't close over $logWriter cleanly, so we
# pass a synchronized hashtable as -MessageData to share state.
"[tray] starting ledgerlens launcher: $launcherJs" | Out-File -FilePath $logFile -Append -Encoding utf8

$proc = [System.Diagnostics.Process]::new()
$proc.StartInfo           = $psi
$proc.EnableRaisingEvents = $true

$script:serverUrl = $null
$shared = [hashtable]::Synchronized(@{
    LogFile   = $logFile
    ServerUrl = $null
})

$onOut = {
    if ($null -eq $EventArgs.Data) { return }
    $line = $EventArgs.Data
    Add-Content -Path $Event.MessageData.LogFile -Value $line -Encoding utf8
    if ($line -match 'server is live at (https?://[^\s]+)') {
        $Event.MessageData.ServerUrl = $Matches[1]
    }
}
$onErr = {
    if ($null -eq $EventArgs.Data) { return }
    Add-Content -Path $Event.MessageData.LogFile -Value ("[stderr] " + $EventArgs.Data) -Encoding utf8
}
Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $shared -Action $onOut | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -MessageData $shared -Action $onErr | Out-Null

[void]$proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

# Poll the shared hashtable from the UI thread to update the tray icon
# state when the server signals it's live. WinForms timers fire on the
# UI thread, so we can safely touch $script:trayIcon from here.
$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 500
$statusTimer.Add_Tick({
    if ($shared.ServerUrl -and -not $script:serverUrl) {
        $script:serverUrl = $shared.ServerUrl
        $script:trayIcon.Text = "Ledgerlens (running)"
        $script:openChatItem.Enabled = $true
    }
}.GetNewClosure())
$statusTimer.Start()

# ─── Tray icon ───────────────────────────────────────────────────────────
$iconPath = Join-Path $runDir 'assets\icon-32.png'
if (Test-Path $iconPath) {
    $bmp = [System.Drawing.Image]::FromFile($iconPath)
    $hicon = ([System.Drawing.Bitmap]$bmp).GetHicon()
    $script:iconRunning = [System.Drawing.Icon]::FromHandle($hicon)
} else {
    $script:iconRunning = [System.Drawing.SystemIcons]::Application
}
$script:iconStarting = $script:iconRunning

$script:trayIcon = New-Object System.Windows.Forms.NotifyIcon
$script:trayIcon.Icon = $script:iconStarting
$script:trayIcon.Text = "Ledgerlens (starting...)"
$script:trayIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openExcel = $menu.Items.Add("Open Excel")
$script:openChatItem = $menu.Items.Add("Open chat in browser")
$script:openChatItem.Enabled = $false
[void]$menu.Items.Add('-')
$showLogs = $menu.Items.Add("Show logs")
$about    = $menu.Items.Add("About Ledgerlens")
[void]$menu.Items.Add('-')
$stop     = $menu.Items.Add("Stop Ledgerlens")
$script:trayIcon.ContextMenuStrip = $menu

# ─── Menu handlers ───────────────────────────────────────────────────────
$openExcel.Add_Click({
    Start-Process 'cmd.exe' '/c start "" excel' -WindowStyle Hidden
}.GetNewClosure())

$script:openChatItem.Add_Click({
    if ($script:serverUrl) { Start-Process $script:serverUrl }
}.GetNewClosure())

$showLogs.Add_Click({
    Start-Process explorer.exe $logDir
}.GetNewClosure())

$about.Add_Click({
    [System.Windows.Forms.MessageBox]::Show(
        "Ledgerlens`nLocal AI assistant for Microsoft Excel.`n`nhttps://github.com/adityavaish/ledgerlens",
        "About Ledgerlens", 'OK', 'Information'
    ) | Out-Null
}.GetNewClosure())

$stopHandler = {
    try {
        $script:trayIcon.Visible = $false
        if ($proc -and -not $proc.HasExited) {
            try { $proc.CloseMainWindow() | Out-Null } catch {}
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
        # Best-effort registry cleanup (launcher does the same on graceful exit,
        # but if it was killed forcibly the entry may linger).
        cmd /c "reg delete `"HKCU\Software\Microsoft\Office\16.0\Wef\Developer`" /v Ledgerlens /f >nul 2>&1" | Out-Null
    } finally {
        [System.Windows.Forms.Application]::Exit()
    }
}
$stop.Add_Click($stopHandler.GetNewClosure())

# Also exit cleanly if the child process dies on its own.
Register-ObjectEvent -InputObject $proc -EventName Exited -Action {
    $logWriter.WriteLine("[tray] child process exited (code " + $proc.ExitCode + ")")
    $script:trayIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
} | Out-Null

# Brief balloon so the user knows the app is running, then runs silently.
$script:trayIcon.BalloonTipTitle = "Ledgerlens is starting"
$script:trayIcon.BalloonTipText  = "Excel will open in a moment. Right-click the tray icon for options."
$script:trayIcon.ShowBalloonTip(3000)

[System.Windows.Forms.Application]::Run()

# Cleanup
$logWriter.Close()