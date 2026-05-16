# Ledgerlens — one-line installer (Windows / PowerShell).
#
# Downloads the latest release tarball from GitHub, extracts it into
# %LOCALAPPDATA%\ledgerlens\versions\<version>, drops a launcher CMD shim
# into %LOCALAPPDATA%\Programs\ledgerlens, creates Start-menu + Desktop
# shortcuts, and adds the bin dir to the current-user PATH. After install,
# the user clicks "Ledgerlens" in their Start menu to launch.
#
# Designed to be SmartScreen-friendly and runnable by non-technical users.
# Auto-installs Node.js via winget if missing.

$ErrorActionPreference = 'Stop'
$repo = 'adityavaish/ledgerlens'

function Step($msg)    { Write-Host "  -> $msg" -ForegroundColor Cyan }
function Ok($msg)      { Write-Host "  OK $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "  !  $msg" -ForegroundColor Yellow }
function Fail($msg)    { Write-Host "  X  $msg" -ForegroundColor Red }

# 1. Resolve install dirs.
$installDir = Join-Path $env:LOCALAPPDATA 'ledgerlens'
$binDir     = Join-Path $env:LOCALAPPDATA 'Programs\ledgerlens'
$startMenu  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktop    = [Environment]::GetFolderPath('Desktop')
New-Item -ItemType Directory -Force -Path $installDir, $binDir | Out-Null

# 2. Ensure Node.js 22+ is available. Try winget if missing.
function Get-NodeVersion {
    try { $v = (& node --version 2>$null).Trim(); return $v } catch { return $null }
}

$nodeVer = Get-NodeVersion
if ($nodeVer) {
    $major = [int]($nodeVer -replace '^v(\d+).*','$1')
    if ($major -lt 22) {
        Warn "Node.js $nodeVer is too old; need 22+. Will attempt to upgrade."
        $nodeVer = $null
    } else {
        Ok "Node.js $nodeVer detected"
    }
}

if (-not $nodeVer) {
    Step "Node.js 22+ is required. Installing via winget..."
    try {
        & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "winget exited with $LASTEXITCODE" }
    } catch {
        Fail "Could not install Node.js automatically. Please install it from https://nodejs.org/ and re-run this installer."
        exit 1
    }
    # winget puts node in a new PATH entry; refresh this session's PATH so we see it.
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $nodeVer = Get-NodeVersion
    if (-not $nodeVer) {
        Fail "Node.js install completed but `node` is not on PATH yet. Please restart this terminal and re-run."
        exit 1
    }
    Ok "Node.js $nodeVer installed"
}

# 3. Resolve latest release on GitHub.
Step "Looking up the latest Ledgerlens release..."
$headers = @{ 'User-Agent' = 'ledgerlens-installer'; 'Accept' = 'application/vnd.github+json' }
$rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
$version = ($rel.tag_name -as [string]) -replace '^v',''
$asset = $rel.assets | Where-Object { $_.name -match '\.tgz$' } | Select-Object -First 1
$downloadUrl = if ($asset) { $asset.browser_download_url } else { $rel.tarball_url }
if (-not $downloadUrl) { throw 'Could not find a release asset to download.' }
Ok "Latest release is v$version"

# 4. Download + extract.
Step "Downloading v$version..."
$versionsDir = Join-Path $installDir 'versions'
$targetDir   = Join-Path $versionsDir $version
New-Item -ItemType Directory -Force -Path $versionsDir, $targetDir | Out-Null
$tmpTar = Join-Path $env:TEMP "ledgerlens-$version.tgz"
Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $tmpTar -Headers $headers
& tar -xzf $tmpTar -C $targetDir --strip-components=1
Remove-Item $tmpTar -Force
Ok "Extracted to $targetDir"

# 5. Install runtime npm dependencies. Shipping node_modules in the tarball
# would balloon the download; running `npm install --omit=dev` once after
# extract gives the same effect for ~140 KB on the wire.
Step "Installing runtime dependencies (about a minute)..."
Push-Location $targetDir
try {
    & npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 |
        Where-Object { $_ -notmatch '^npm (warn|notice)' -and $_ -notmatch '^\s*$' } |
        ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
Ok "Dependencies installed"

# 6. Pin "current" to the just-installed version.
$current = @{ version = $version; path = $targetDir; installedAt = (Get-Date).ToString('o') } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $installDir 'current.json'), $current, (New-Object System.Text.UTF8Encoding $false))

# 7. Stable dispatcher + .cmd shim. The dispatcher reads current.json each
# launch so future auto-updates take effect without re-running the installer.
$dispatcher = @"
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const installDir = process.env.LEDGERLENS_HOME ||
  (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ledgerlens') : path.join(require('os').homedir(), '.ledgerlens'));
let cur;
try {
  let _raw = fs.readFileSync(path.join(installDir, 'current.json'), 'utf8');
  if (_raw.charCodeAt(0) === 0xFEFF) _raw = _raw.slice(1);
  cur = JSON.parse(_raw);
} catch (err) {
  console.error('[ledgerlens] no current.json at ' + installDir + ' \u2014 reinstall from https://github.com/adityavaish/ledgerlens');
  process.exit(1);
}
const launcher = path.join(cur.path, 'bin', 'ledgerlens.js');
if (!fs.existsSync(launcher)) {
  console.error('[ledgerlens] launcher missing at ' + launcher + ' \u2014 reinstall.');
  process.exit(1);
}
const r = spawnSync(process.execPath, [launcher, ...process.argv.slice(2)], { stdio: 'inherit', shell: false });
process.exit(r.status == null ? 1 : r.status);
"@
[System.IO.File]::WriteAllText((Join-Path $binDir 'ledgerlens-dispatch.js'), $dispatcher, (New-Object System.Text.UTF8Encoding $false))

$shim = "@echo off`r`nnode `"%LOCALAPPDATA%\Programs\ledgerlens\ledgerlens-dispatch.js`" %*`r`n"
Set-Content -Path (Join-Path $binDir 'ledgerlens.cmd') -Value $shim -Encoding ASCII

# 8. Add bin to user PATH for ad-hoc terminal use.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDir), 'User')
    Ok "Added $binDir to your user PATH"
}

# 9. Create Start menu + Desktop shortcuts pointing at ledgerlens.cmd so
# non-technical users can launch from familiar places. Uses the WScript
# Shell COM API which is present on every Windows install.
function New-LedgerlensShortcut($linkPath, $description) {
    # Shortcuts launch via wscript -> the silent VBS launcher -> the tray
    # PowerShell host. Result: clicking the shortcut shows no console
    # window at all; the user only sees the system-tray icon + Excel.
    $shellApp = New-Object -ComObject WScript.Shell
    $lnk = $shellApp.CreateShortcut($linkPath)
    $lnk.TargetPath       = "$env:WINDIR\System32\wscript.exe"
    $lnk.Arguments        = '"' + (Join-Path $targetDir 'bin\ledgerlens-tray.vbs') + '"'
    $lnk.WorkingDirectory = $targetDir
    $lnk.IconLocation     = (Join-Path $targetDir 'assets\icon-128.png')
    $lnk.Description      = $description
    $lnk.WindowStyle      = 7  # Minimized; wscript itself is windowless so this is just a hint.
    $lnk.Save()
}

$startLink   = Join-Path $startMenu 'Ledgerlens.lnk'
$desktopLink = Join-Path $desktop   'Ledgerlens.lnk'
New-LedgerlensShortcut -linkPath $startLink   -description 'Ledgerlens AI assistant for Excel'
New-LedgerlensShortcut -linkPath $desktopLink -description 'Ledgerlens AI assistant for Excel'
Ok "Start menu and desktop shortcuts created"

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " Ledgerlens v$version is installed!"                       -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
Write-Host " To start it:" -ForegroundColor White
Write-Host "   * Double-click 'Ledgerlens' on your desktop, OR"
Write-Host "   * Open the Start menu and search for 'Ledgerlens'."
Write-Host ""
Write-Host " Excel will open automatically with the Ledgerlens" -ForegroundColor White
Write-Host " add-in installed. Click the Ledgerlens button on the"
Write-Host " Home tab to open the chat panel."
Write-Host ""
Write-Host " The first launch may ask you to trust a local development"  -ForegroundColor DarkGray
Write-Host " certificate so the add-in can talk to the local server."   -ForegroundColor DarkGray
Write-Host " Click 'Yes' when Windows prompts you."                     -ForegroundColor DarkGray
Write-Host ""