@echo off
REM ===========================================================================
REM  Ledgerlens - Bootstrap Installer
REM
REM  Double-click this file to install Ledgerlens. It will:
REM    1. Make sure Node.js 22+ is installed (uses `winget` if needed).
REM    2. Download the latest Ledgerlens release from GitHub.
REM    3. Set up Start-menu + Desktop shortcuts you can use to launch it.
REM
REM  No admin rights are required for the install itself - everything goes into
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

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Write-Host 'Downloading installer...';" ^
  "$bytes = (Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/adityavaish/ledgerlens/releases/latest/download/install.ps1').Content;" ^
  "$text  = if ($bytes -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($bytes) } else { $bytes };" ^
  "Invoke-Expression $text"

set EXITCODE=%ERRORLEVEL%
if not defined EXITCODE set EXITCODE=1

echo.
if "%EXITCODE%"=="0" goto :ok
goto :fail

:ok
echo  ============================================================
echo    Done! Find "Ledgerlens" in your Start menu to launch it.
echo  ============================================================
goto :end

:fail
echo  ============================================================
echo    Install ran into a problem. Exit code: %EXITCODE%
echo    Please report the error output above at:
echo      https://github.com/adityavaish/ledgerlens/issues
echo  ============================================================
goto :end

:end
echo.
pause >nul
endlocal
exit /b %EXITCODE%