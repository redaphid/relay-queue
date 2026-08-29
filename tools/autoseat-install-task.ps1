# Registers the Scheduled Task that keeps tools/autoseat.js running.
#
# Task name: relay-autoseat
#
# KEEP THIS FILE PURE ASCII (see the header of autoseat-start.ps1 for why).
#
# Run once, from a normal (non-admin) PowerShell:
#   powershell -ExecutionPolicy Bypass -File D:\projects\relay-queue\tools\autoseat-install-task.ps1
#
# Remove with:
#   Unregister-ScheduledTask -TaskName relay-autoseat -Confirm:$false
#
# Design notes, because the obvious alternatives do not work here:
#
#  * THE REPEATING TRIGGER IS THE SUPERVISOR. autoseat-start.ps1 no-ops when a
#    node process is already running autoseat.js, so firing every 5 minutes
#    cannot produce duplicates - and a death of any kind is repaired within 5
#    minutes. A plain at-logon trigger would leave the dispatcher dead until the
#    next reboot, which is precisely the state this box was found in: it ran for
#    24 hours, its parent terminal closed, and nothing brought it back.
#
#  * IT RUNS AS THE INTERACTIVE USER, NOT AS SYSTEM AND NOT AS S4U. autoseat
#    spawns `claude` as a child, and claude runs out of this user's profile
#    (credentials, settings, MCP config under C:\Users\hypnodroid). Interactive
#    is also the convention every other host-process task on this box already
#    follows (speak-mcp, playwright-mcp), so there is one shape to reason about
#    rather than two. RunLevel is Limited: nothing here needs elevation, and an
#    elevated dispatcher would hand every coordinator it spawns admin rights it
#    has no reason to hold.
#
#    KNOWN LIMIT, stated rather than discovered later: an Interactive task does
#    not run while nobody is logged on. A locked screen is fine; a logged-out or
#    freshly-rebooted-to-the-login-screen box is not, and auto-seating is dead
#    until he logs in. That is an accepted trade, not an oversight - the
#    alternative (S4U, like OllamaProxySupervisor) runs in session 0, and no
#    evidence exists here that `claude` authenticates correctly from there.
#    If auto-seating while logged out ever matters, TEST claude in session 0
#    first; do not just switch the LogonType and assume.
#
#  * MultipleInstances IgnoreNew and ExecutionTimeLimit 0 both matter. The first
#    stops a slow tick from stacking on the next one; the second stops Task
#    Scheduler killing the launcher mid-start on a long-running default.

$ErrorActionPreference = 'Stop'
$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'relay-autoseat'
$vbs = Join-Path $tools 'autoseat-start.vbs'

if (-not (Test-Path $vbs)) { throw "missing $vbs" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $tools

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Repetition is what makes this self-healing; see the note above.
# -RepetitionDuration is deliberately omitted: Task Scheduler treats an absent
# duration as "repeat indefinitely". Passing [TimeSpan]::MaxValue instead emits
# P99999999DT23H59M59S, which the task XML schema rejects outright.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# Idempotent: replace any previous registration rather than erroring.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask -TaskName $taskName `
    -Description 'Keeps relay-queue tools/autoseat.js running, so a tab with a human message and no live coordinator seats itself. Re-runs every 5 minutes; the start script no-ops when it is already up.' `
    -Action $action -Trigger @($atLogon, $repeat) -Principal $principal -Settings $settings | Out-Null

Write-Output "registered scheduled task '$taskName'"
Start-ScheduledTask -TaskName $taskName
Write-Output "started it"
