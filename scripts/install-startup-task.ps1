<#
.SYNOPSIS
  Registers the "Naat Research Queue" Windows scheduled task.

.DESCRIPTION
  The task runs scripts\run-queue-hidden.vbs:
    * at logon (2 minute delay, so PATH, Docker and the AI service are ready)
    * every N minutes afterwards (default 30), so jobs added mid-session get picked up
  Output from every run is appended to queue\logs\queue-<timestamp>.log
  (only the 20 newest logs are kept).

  Runs only while the user is logged on (no stored password needed) and starts
  hidden - no console window. Concurrent runs are suppressed twice: Task
  Scheduler "IgnoreNew" plus the lock file queue\.processor.lock in
  process-queue.cjs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1 -NoStart
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Naat Research Queue",
  [int]$RepeatMinutes = 30,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "scripts\run-queue-hidden.vbs"
if (-not (Test-Path $launcher)) { throw "Missing launcher: $launcher" }
if ($RepeatMinutes -lt 5) { throw "-RepeatMinutes must be >= 5" }

$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "wscript.exe" `
  -Argument "//B //Nologo `"$launcher`"" `
  -WorkingDirectory $root

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$atLogon.Delay = "PT2M"

$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
  -Action $action `
  -Trigger @($atLogon, $repeat) `
  -Settings $settings `
  -Principal $principal `
  -Description "Drains queue\jobs.json: YouTube audio -> AI explanation detection -> trimmed video cuts. Logs in queue\logs." `
  -Force | Out-Null

Write-Host "Registered task '$TaskName'"
Write-Host "  runs at logon (+2 min) and every $RepeatMinutes min"
Write-Host "  launcher: $launcher"
Write-Host "  logs:     $root\queue\logs"

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "  task started now (check queue\logs for progress)"
}
