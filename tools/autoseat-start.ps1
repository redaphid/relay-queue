# Starts tools/autoseat.js if it is not already running. Idempotent by design.
#
# KEEP THIS FILE PURE ASCII. PowerShell reads an unsigned .ps1 as CP-1252, so a
# UTF-8 em-dash or curly quote silently terminates a string literal and the
# script fails to PARSE - at boot, with nobody watching. Plain hyphens only.
#
# WHY THIS EXISTS.
#
# autoseat.js is the last mile of the dispatch chain: relay-queue and
# relay-watchdog are containers and cannot execute `claude`, so the thing that
# actually seats a coordinator has to be a host process. For its first day it
# was one a human started by hand, and on 2026-08-29 that came due: the log
# shows it watching continuously from 00:50:36 on 08-28 to 00:32:56 on 08-29,
# then stopping mid-stream with an EMPTY .err.log - no crash, no stack, just a
# parent terminal closing and taking the process with it. Twenty minutes later
# a human message sat in the Flux Pavilion tab for 14+ minutes with nobody
# seated, which is exactly the failure autoseat was written to prevent.
#
# That is the whole point: the supervisor of the auto-seater was a person
# remembering. This file replaces the remembering.
#
# HOW THE SUPERVISION WORKS.
#
# The scheduled task (see autoseat-install-task.ps1) runs this at logon AND
# every 5 minutes forever. The already-running check below is what makes the
# repetition safe: a tick while autoseat is healthy does nothing at all, so the
# repeating trigger acts as a free supervisor. If the process dies for any
# reason - crash, terminal close, someone killing it - the next tick brings it
# back within 5 minutes, with no duplicates and no service wrapper.
#
# WHY THE LIVENESS CHECK IS A PROCESS MATCH AND NOT A PORT.
#
# speak-mcp and playwright-mcp can just connect to their own port. autoseat
# listens on nothing - it is a pure poller - so there is no socket to probe.
# The honest check is therefore "is a node process running autoseat.js".
#
# The Name filter is load-bearing, not decoration. This script's own path
# contains the string "autoseat", and so does the wscript/powershell command
# line that launches it, so a bare CommandLine match finds THIS process and
# concludes autoseat is already up - forever, having started nothing. Matching
# node.exe specifically is what makes the check capable of returning false.
#
# WHY EXISTENCE IS NOT ENOUGH, AND WHAT THE HEARTBEAT ADDS.
#
# "A node.exe with autoseat.js in its command line exists" is a check that a
# process which is RUNNING BUT NO LONGER WORKING passes forever. autoseat's
# whole job is to poll; a poll stuck on a fetch that never returns leaves a
# process that is alive, responding, and useless - and this supervisor, built
# precisely to recover autoseat, could not recover it from that.
#
# Nothing already on disk could stand in for the missing signal, which is why
# a new file exists rather than a new reading of an old one:
#
#   * THE LOG CANNOT. autoseat prints "nothing to seat" only when the text
#     CHANGES, so a healthy process with a steady queue writes nothing for
#     hours BY DESIGN. On 2026-08-29 a 16.7-hour gap in the log was escalated
#     as a hang and was not one - the process had been polling correctly the
#     whole time, and proving that took TCP-socket forensics, because no file
#     on disk distinguished "idle and fine" from "wedged". Log silence is not
#     evidence of death, and log freshness is not evidence of life.
#
#   * state.json CANNOT. It is written only when a coordinator is dispatched,
#     so days of correct operation leave it untouched.
#
# So autoseat now stamps heartbeat.json when a poll RUNS TO COMPLETION (not
# when one starts - setInterval keeps firing behind a hung fetch, so an
# on-entry stamp would stay fresh through the exact fault this catches). This
# script treats a stale heartbeat as death, kills the stale pid, and starts a
# fresh one.
#
# THE THRESHOLD IS A JUDGEMENT, SO HERE IS THE ARITHMETIC. autoseat polls
# every 10s, so a healthy heartbeat is at most ~10s old. Its two GETs each
# carry an 8s timeout, so even a pathologically slow relay completes a tick in
# ~16s. 120s is therefore 12 normal poll intervals and ~7 worst-case ticks - far
# enough above normal that a GC pause, a disk stall or a slow relay cannot trip
# it, and still well under the task's own 5-minute cadence, so a genuine wedge
# is repaired on the very next tick rather than the one after.
#
# NOT KILLING A HEALTHY PROCESS MATTERS AS MUCH AS KILLING A WEDGED ONE: a
# supervisor that thrashes is worse than one that hangs, because it destroys
# in-flight coordinators on a timer. Two guards exist for that. A process
# younger than the threshold is left alone outright, since it has not yet had
# time to prove itself. And a relay outage is explicitly NOT a wedge -
# autoseat beats on the "queue unreachable" path too, because restarting this
# process cannot fix a down relay and doing so every 5 minutes would shred the
# run history that an outage most needs.

$ErrorActionPreference = 'Stop'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $tools
$entry = Join-Path $tools 'autoseat.js'
if (-not (Test-Path $entry)) { throw "missing $entry" }

$stateDir = Join-Path $env:USERPROFILE '.relay-autoseat'
$logFile = Join-Path $stateDir 'autoseat.log'
$errFile = Join-Path $stateDir 'autoseat.err.log'
$heartbeatFile = Join-Path $stateDir 'heartbeat.json'

# See the threshold arithmetic in the header before changing this.
$staleSeconds = 120

# Already running? See the note above on why Name is filtered, and why being
# alive is not by itself good enough.
$live = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'autoseat\.js' })

if ($live.Count -gt 0) {
    $wedged = $null
    $ageSec = $null

    # A process too young to have proved anything is left alone. Without this
    # the supervisor would kill every autoseat it started, five minutes later,
    # forever.
    $youngest = ($live | ForEach-Object { ((Get-Date) - $_.CreationDate).TotalSeconds } |
        Measure-Object -Minimum).Minimum

    if ($youngest -lt $staleSeconds) {
        Write-Output "autoseat running (pid $($live[0].ProcessId)), started $([int]$youngest)s ago - startup grace"
        exit 0
    }

    if (-not (Test-Path $heartbeatFile)) {
        $wedged = "no heartbeat file at $heartbeatFile"
    } else {
        $hb = $null
        try { $hb = Get-Content $heartbeatFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $hb = $null }

        if (-not $hb -or -not $hb.ts) {
            $wedged = 'heartbeat file is missing or unreadable'
        } else {
            # ConvertFrom-Json may hand back a [datetime] already, or the raw
            # string. Handle both rather than assuming, because guessing wrong
            # here throws inside a scheduled task nobody is watching.
            if ($hb.ts -is [datetime]) {
                $hbUtc = $hb.ts.ToUniversalTime()
            } else {
                $hbUtc = [datetime]::Parse([string]$hb.ts,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            }
            $ageSec = ([datetime]::UtcNow - $hbUtc).TotalSeconds
            $livePids = @($live | ForEach-Object { [int]$_.ProcessId })

            if ($ageSec -gt $staleSeconds) {
                $wedged = "heartbeat is $([int]$ageSec)s old, limit is $staleSeconds s"
            } elseif ($livePids -notcontains [int]$hb.pid) {
                # A fresh heartbeat proves SOME process is polling, not that
                # THIS one is. A stray --once run refreshing the file would
                # otherwise vouch for a daemon that had already died.
                $wedged = "heartbeat belongs to pid $($hb.pid), which is not a running autoseat"
            }
        }
    }

    if (-not $wedged) {
        Write-Output "autoseat healthy (pid $($live[0].ProcessId), heartbeat $([int]$ageSec)s old)"
        exit 0
    }

    # Wedged. Kill it, then start a fresh one below.
    $utc = [datetime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss')
    $ids = ($live | ForEach-Object { $_.ProcessId }) -join ', '
    Write-Output "autoseat wedged (pid $ids): $wedged - restarting"

    $killErrors = @()
    foreach ($p in $live) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop }
        catch { $killErrors += "pid $($p.ProcessId): $($_.Exception.Message)" }
    }
    Start-Sleep -Milliseconds 500

    # THE RESTART NOTE IS WRITTEN AFTER THE KILL, AND CANNOT ABORT IT.
    #
    # Both halves of that sentence are scars. The dying process holds
    # autoseat.log open through cmd's >> redirection, so appending to it while
    # that process is still alive fails with "being used by another process" -
    # and under $ErrorActionPreference = 'Stop' that terminated the supervisor
    # mid-recovery, so it correctly identified a wedged autoseat and then did
    # nothing whatsoever about it. That is a worse bug than the one this file
    # was opened to fix, and only running it revealed it. Logging is
    # best-effort; recovery is not.
    $line = "$utc  SUPERVISOR restarting wedged autoseat (pid $ids): $wedged"
    if ($killErrors.Count) { $line += " [kill errors: $($killErrors -join '; ')]" }
    try { Add-Content -Path $logFile -Value $line -ErrorAction Stop }
    catch { Write-Output "could not append the restart note: $($_.Exception.Message)" }

    # NEVER START A SECOND DISPATCHER. If the kill did not take, the wedged
    # process is still polling, and adding another one means two autoseats
    # racing to seat the same tabs - the double-dispatch this whole tool is
    # built to make impossible. Leaving one wedged autoseat running is bad;
    # two running autoseats is worse.
    $still = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'autoseat\.js' })
    if ($still.Count -gt 0) {
        $stillIds = ($still | ForEach-Object { $_.ProcessId }) -join ', '
        Write-Output "FAILED to kill wedged autoseat (pid $stillIds); refusing to start a second one"
        exit 1
    }
}

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }

# Start-Process's -RedirectStandardOutput/-Error ALWAYS truncate the target -
# there is no append option. The task tick restarts autoseat on every crash
# (up to every 5 minutes), so truncate-on-start silently erases the run
# history a post-mortem needs, right when a post-mortem is most likely to be
# needed. So: run through cmd.exe and use shell >> append redirection
# instead of PowerShell's redirect parameters.
#
# Size-capped rotation: an appended log grows forever otherwise. Roll it
# aside once it crosses ~10 MB, keeping exactly one prior generation - big
# enough to hold weeks of normal ticks, small enough to never matter.
$maxBytes = 10MB
foreach ($f in @($logFile, $errFile)) {
    if ((Test-Path $f) -and (Get-Item $f).Length -gt $maxBytes) {
        Move-Item $f "$f.1" -Force
    }
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\tools\node\node.exe' }
if (-not (Test-Path $node)) { throw "node.exe not found (looked for $node)" }

# Run from the repo root so autoseat.js resolves its own relative paths the way
# it does when a human runs `node tools/autoseat.js` from the checkout.
#
# The whole "/c ..." command must be passed to Start-Process as ONE string
# with the entire command wrapped in an extra pair of quotes. Passing it as
# an array (e.g. -ArgumentList @('/c', $cmdLine)) makes PowerShell re-quote
# the already-quoted inner string, which cmd.exe's argument parser then
# mis-splits - it looks like it started (a PID comes back) but node never
# actually runs and nothing is ever written, silently.
$cmdLine = '"' + $node + '" tools\autoseat.js >> "' + $logFile + '" 2>> "' + $errFile + '"'
$argStr = '/c "' + $cmdLine + '"'
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList $argStr `
    -WorkingDirectory $root `
    -WindowStyle Hidden

Write-Output "started autoseat from $root"
