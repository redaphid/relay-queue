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

$ErrorActionPreference = 'Stop'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $tools
$entry = Join-Path $tools 'autoseat.js'
if (-not (Test-Path $entry)) { throw "missing $entry" }

$stateDir = Join-Path $env:USERPROFILE '.relay-autoseat'
$logFile = Join-Path $stateDir 'autoseat.log'
$errFile = Join-Path $stateDir 'autoseat.err.log'

# Already running? Nothing to do. See the note above on why Name is filtered.
$live = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'autoseat\.js' })
if ($live.Count -gt 0) {
    Write-Output "autoseat already running (pid $($live[0].ProcessId))"
    exit 0
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
