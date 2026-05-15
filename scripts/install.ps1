# Ledgerlens — one-line installer (Windows / PowerShell).
#
# Downloads the latest release tarball from GitHub, extracts it into
# %LOCALAPPDATA%\ledgerlens\versions\<version>, drops a launcher CMD shim
# into %LOCALAPPDATA%\Programs\ledgerlens, and adds that folder to the
# current-user PATH. After install, open a fresh terminal and run:
#
#     ledgerlens
#
# Re-run this installer any time to pick up the latest version manually,
# although the launcher itself self-updates on every run.

$ErrorActionPreference = 'Stop'
$repo = 'adityavaish/ledgerlens'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 1. Resolve install dirs.
$installDir = Join-Path $env:LOCALAPPDATA 'ledgerlens'
$binDir     = Join-Path $env:LOCALAPPDATA 'Programs\ledgerlens'
New-Item -ItemType Directory -Force -Path $installDir, $binDir | Out-Null

# 2. Require Node.js >= 22.
$nodeVer = $null
try { $nodeVer = (& node --version 2>$null).Trim() } catch {}
if (-not $nodeVer -or [int]($nodeVer -replace '^v(\d+).*','$1') -lt 22) {
    Write-Host ""
    Write-Host "Ledgerlens requires Node.js 22 or later." -ForegroundColor Yellow
    Write-Host "Install it from https://nodejs.org/ (or via winget):"
    Write-Host "    winget install OpenJS.NodeJS.LTS"
    Write-Host ""
    exit 1
}
Step "node $nodeVer detected"

# 3. Look up the latest release.
Step "querying github.com/$repo for latest release"
$headers = @{ 'User-Agent' = 'ledgerlens-installer'; 'Accept' = 'application/vnd.github+json' }
$rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
$version = ($rel.tag_name -as [string]) -replace '^v',''
$asset = $rel.assets | Where-Object { $_.name -match '\.tgz$' } | Select-Object -First 1
$downloadUrl = if ($asset) { $asset.browser_download_url } else { $rel.tarball_url }
if (-not $downloadUrl) { throw "Could not find a release asset to download." }
Step "downloading v$version"

# 4. Download + extract via tar (Windows 10+ ships bsdtar; gzip auto-detected).
$versionsDir = Join-Path $installDir 'versions'
$targetDir   = Join-Path $versionsDir $version
New-Item -ItemType Directory -Force -Path $versionsDir, $targetDir | Out-Null
$tmpTar = Join-Path $env:TEMP "ledgerlens-$version.tgz"
Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $tmpTar -Headers $headers
& tar -xzf $tmpTar -C $targetDir --strip-components=1
Remove-Item $tmpTar -Force

# 4b. Install runtime npm dependencies in the extracted version. The
# release tarball ships package.json + package-lock.json but not
# node_modules; without this step the server boots and immediately fails
# with "Cannot find module 'express'".
Step "installing runtime dependencies (this is a one-time step per release)"
Push-Location $targetDir
try {
    & npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

# 5. Pin "current" to the just-installed version.
$current = @{ version = $version; path = $targetDir; installedAt = (Get-Date).ToString('o') } | ConvertTo-Json
Set-Content -Path (Join-Path $installDir 'current.json') -Value $current -Encoding UTF8

# 6. Write a launcher CMD shim that invokes node on bin\ledgerlens.js.
$shim = @"
@echo off
node "$targetDir\bin\ledgerlens.js" %*
"@
Set-Content -Path (Join-Path $binDir 'ledgerlens.cmd') -Value $shim -Encoding ASCII

# 7. Add the bin dir to the current-user PATH if not already on it.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDir), 'User')
    Step "added $binDir to your user PATH (open a new terminal to pick it up)"
}

Step "ledgerlens v$version installed at $targetDir"
Write-Host ""
Write-Host "Run it with:  ledgerlens"
Write-Host "Source/docs:  https://github.com/$repo"
Write-Host ""
