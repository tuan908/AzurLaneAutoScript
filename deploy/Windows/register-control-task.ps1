param(
    [switch]$Unregister,
    [ValidateRange(1, 65535)][int]$Port = 22267,
    [string]$TaskName = 'ALAS Control Center'
)

$ErrorActionPreference = 'Stop'
if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    return
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Launcher = Join-Path $Root 'start-control.vbs'
if (!(Test-Path (Join-Path $Root 'dashboard\dist\index.html'))) {
    throw 'Build dashboard/dist before registering the task.'
}
if (!(Test-Path (Join-Path $Root 'toolkit\python.exe'))) {
    throw 'Install the ALAS toolkit in this checkout before registering the task.'
}

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument "`"$Launcher`" $Port" -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force
