# HANDOFF resume - work log (agent `HandoffResume`, 2026-08-29)

Operational log, appended as each task closes, so a crash on this box does not
lose the thread. Terse on purpose. The narrative lives in `HANDOFF.md`.

## Task 1 - autoseat supervision (HANDOFF 3.2 / 3.5) - DONE

**Verified first, did not assume:** `Get-CimInstance Win32_Process` found no
`autoseat` process. `~/.relay-autoseat/autoseat.log` shows it watching
continuously from `2026-08-28 00:50:36` to `2026-08-29 00:32:56`, then stopping
mid-stream. `.err.log` was **0 bytes** - no crash, no stack. It died with its
parent terminal, ~3.5h before this pass. This *refines* HANDOFF 3.2, which
guessed it had been started by hand mid-session; it actually ran ~24h straight.

**Shipped** (commit `ebf6331`, merged `dc45a4e`, backup tag
`pre-autoseat-supervision-merge` -> `98979b9`):

- `tools/autoseat-start.ps1` - idempotent starter, pure ASCII
- `tools/autoseat-start.vbs` - suppresses the console flash every tick
- `tools/autoseat-install-task.ps1` - registers Scheduled Task `relay-autoseat`
- `COORDINATOR.md` - documents the task, the ASCII rule, and the logged-out limit

Deliberately follows the existing box convention (`speak-mcp`, `playwright-mcp`:
`start.vbs` + `wscript` + AtLogon + 5-min repeating trigger, InteractiveToken,
`MultipleInstances IgnoreNew`) rather than inventing a mechanism.

**Load-bearing detail:** the liveness check filters `Name='node.exe'` before
matching `autoseat\.js`. The start script's own path contains "autoseat", so a
bare CommandLine match self-matches, reports "already running", and starts
nothing forever.

**Proof (each step watched, not assumed):**
- pure ASCII asserted, with a deliberate em-dash control that made the check go red
- both `.ps1` parse clean via `[Parser]::ParseFile`, with a broken control that produced 2 errors
- installed -> autoseat came up as pid 42132 and immediately auto-seated the
  real pending backlog (`main` x2 messages, `HANDOFF.md writer` x1)
- 2 extra ticks -> still exactly 1 process, same pid (no duplicates)
- killed pid 42132 -> count 0 (the check can see "dead")
- unattended recovery on the natural 5-min tick: see below

## Task 2 - COORDINATOR.md Part 2 - see below
## Task 3 - worktree cleanup - see below
## Task 4 - Vikunja #428 - see below
## Task 5 - relay hygiene - see below
