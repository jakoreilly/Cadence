@echo off
setlocal enabledelayedexpansion

rem Generates one timestamped HTML report and leaves it in reports\.
rem Usage: scripts\generate-report.cmd [profile]   (default profile: acme)
rem Run it as many times as you like - each run gets its own filename, so
rem nothing is ever overwritten.

set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=acme"

rem cd to the repo root regardless of where this was launched from.
cd /d "%~dp0.."

if not exist "dist\src\cli.js" (
  echo dist\src\cli.js not found - run "npm run build" first.
  exit /b 1
)

if not exist "profiles\%PROFILE%" (
  echo No profile at profiles\%PROFILE%
  exit /b 1
)

if not exist "reports" mkdir "reports"

rem PowerShell for the timestamp: %date%/%time% are locale-dependent and not
rem safe to parse across machines, PowerShell's format string is not.
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd-HH-mm"') do set "STAMP=%%T"

set "OUT=reports\report-%STAMP%.html"

node dist\src\cli.js report --profile "profiles\%PROFILE%" --out "%OUT%"
if errorlevel 1 (
  echo Report generation failed.
  exit /b 1
)

echo Report written to %OUT%
endlocal
