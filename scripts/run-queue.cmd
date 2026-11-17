@echo off
rem Runs the naat queue processor once and appends everything to queue\logs\.
rem Launched by scripts\run-queue-hidden.vbs (no console window) from the
rem "Naat Research Queue" scheduled task, or run it manually from a terminal.
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%" || exit /b 1

set "LOGDIR=%ROOT%\queue\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Commenting on third-party (source) videos: approved, so enabled here.
rem Manual runs can override with --no-source-comment.
set "NAAT_SOURCE_COMMENT=on"

rem Upload cap per calendar day (YouTube quota allows ~6; keep it human).
rem Main and teenage channels have separate budgets. --force overrides.
set "NAAT_UPLOADS_PER_DAY=3"
set "NAAT_TEEN_UPLOADS_PER_DAY=3"

rem keep the 20 most recent logs
powershell -NoProfile -Command "Get-ChildItem '%LOGDIR%\*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force -ErrorAction SilentlyContinue" >nul 2>&1

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "LOG=%LOGDIR%\queue-%STAMP%.log"

echo [%DATE% %TIME%] starting queue processor>>"%LOG%"
node scripts\process-queue.cjs >>"%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] queue processor exited with code %CODE%>>"%LOG%"
exit /b %CODE%
