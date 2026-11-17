<#
.SYNOPSIS
  Shows the scheduled task state and the tail of the newest queue log.
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Naat Research Queue",
  [int]$Tail = 25
)

$ErrorActionPreference = "Continue"

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$task = Get-ScheduledTask -TaskName $TaskName

Write-Host "Task:    $TaskName"
Write-Host "State:   $($task.State)"
Write-Host "Last:    $($info.LastRunTime)  result 0x$('{0:X8}' -f $info.LastTaskResult)"
Write-Host "Next:    $($info.NextRunTime)"

$root = Split-Path -Parent $PSScriptRoot
$log = Get-ChildItem (Join-Path $root "queue\logs\*.log") -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) {
  Write-Host ""
  Write-Host "== $($log.FullName) (last $Tail lines) =="
  Get-Content $log.FullName -Tail $Tail
} else {
  Write-Host ""
  Write-Host "No logs yet in queue\logs."
}
