@echo off
REM ===========================================================================
REM  Ledgerlens — Bootstrap Installer
REM
REM  Double-click this file (or right-click → Run as administrator if your IT
REM  policy requires it) to install Ledgerlens. It will:
REM    1. Make sure Node.js 22+ is installed (uses `winget` if needed).
REM    2. Download the latest Ledgerlens release from GitHub.
REM    3. Set up Start-menu + Desktop shortcuts you can use to launch it.
REM
REM  No admin rights are required for the install itself — everything goes into
REM  your own user profile. The first time you run this, Windows SmartScreen
REM  may show a "Windows protected your PC" prompt; click "More info" then
REM  "Run anyway" and the install will continue.
REM ===========================================================================

setlocal

title Install Ledgerlens

echo.
echo  ============================================================
echo    Installing Ledgerlens
echo  ============================================================
echo.

REM Launch the PowerShell installer with execution policy bypass scoped to
REM this process only (does not change machine-wide settings). The remote
REM install.ps1 is fetched from the latest GitHub Release every time so the
REM bootstrap .cmd itself never needs to change.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Write-Host 'Downloading installer...';" ^
  "$bytes = (Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/adityavaish/ledgerlens/releases/latest/download/install.ps1').Content;" ^
  "$script = if ($bytes -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($bytes) } else { $bytes };" ^
  "Invoke-Expression $script"

set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" (
  echo  ============================================================
  echo    Done! Find "Ledgerlens" in your Start menu to launch it.
  echo  ============================================================
) else (
  echo  ============================================================
  echo    Install ran into a problem (exit code %EXITCODE%).
  echo    Please copy the error above and report it at:
  echo      https://github.com/adityavaish/ledgerlens/issues
  echo  ============================================================
)
echo.
pause >nul
endlocal
exit /b %EXITCODE%
