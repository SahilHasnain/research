<#
.SYNOPSIS
  Removes the "Naat Research Queue" scheduled task.

.DESCRIPTION
  Stops any running instance, then unregisters the task. Queued jobs and the
  logs in queue\logs are left untouched.
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Naat Research Queue"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Task '$TaskName' is not registered."
  return
}

if ($task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $TaskName
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed task '$TaskName'."
