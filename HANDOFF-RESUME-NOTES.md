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

**Unattended recovery, watched rather than assumed:** killed pid 42132 at
`21:14:07`; the task fired its own natural 5-minute tick at `21:18:23` and
autoseat returned as pid 2732 at `21:18:36`, `LastTaskResult 0`.
**`Start-ScheduledTask` was NOT touched during that window.** A later tick at
`21:23:23` correctly left pid 2732 alone.

Corroboration found afterwards: relay's own watchdog had posted
`Watchdog: AUTOSEAT IS NOT SEATING. 1 tab(s)...` into `main` at `01:24Z` -
detection was working the whole time and reporting into a channel with no
reader, which is the documented shape of this failure.

## Task 2 - COORDINATOR.md Part 2 - DONE (commit `d08ba94`, merge `b86d659`)

Applied only what was re-verified against this box today. Rollback ref
`pre-coord-part2-merge` -> `68ab71a`.

**Applied (each re-measured today):** `WATCH_TICK_MS`=15000 at `server.js:3044`;
`setInterval(pushWatch, ...)` at `:8056`; `sweepVacantChairs()` +
`nudgeStalePending()` at `:3365-3366`; `vikunja-reminders` image/cmd/mount,
`POLL_INTERVAL_SECONDS=60`, single hardcoded `RELAY_CONVERSATION_ID`;
`reminders.js:223` POST to relay; mindmeld `GET /api/search` (bare `/search`
404s); `dataClass` default `coding` returning real coordinator sessions; no
field links a mindmeld session to a relay conversationId; 30-min exclusion at
`mind-meld/CLAUDE.md:124`; `qwen3:4b-instruct` present and plain `qwen3:4b`
absent; `SUMMARIZE_MODEL` + `OLLAMA_URL=...:11436`; `data/` gitignored via
`git check-ignore`; thread re-measured at 17,181 B / 31 msgs / 554 B per msg.

**Newly established, which HANDOFF explicitly never tested:** a real generate
through the gate on `:11436` answered **HTTP 200 in 8s from cold**.

**Deliberately LEFT OUT:** the Vikunja webhook event taxonomy - the API's own
event list needs an auth token (`/api/v1/webhooks/events` -> 401), so it could
not be confirmed firsthand. The conclusion does not depend on it. Part 2c was
not applied at all: it is status commentary about HANDOFF.md itself, not
protocol. The ~20-message threshold was kept but labelled as one data point.

**Flagged, needs his call:** COORDINATOR.md grew 48,515 -> 54,023 bytes
(~1.4k more tokens per coordinator boot, forever). The whole point of 2b was to
cut boot cost, so this is partly self-defeating. Splitting the manual is the
real fix.

## Task 3 - worktree cleanup - DONE

**The junction hazard was REAL, and HANDOFF had not checked it:**
`relay-queue-sse-autoseat\node_modules` was a **Junction -> the LIVE app's**
`D:\projects\relay-queue\node_modules`. A plain `git worktree remove` would have
followed it and destroyed the running server's dependencies.

Order: verified branch merged (0 commits ahead of main, clean tree, and the
`--merged` check discriminates - an unmerged control returns 0) -> `cmd /c rmdir`
the junction with NO `/s` -> confirmed live deps unchanged (56 -> 56 entries)
-> `git worktree remove` -> `git branch -d`. Server still 200, all declared deps
resolve. My own two worktrees were checked for junctions (none) and removed.

## Task 4 - Vikunja #428 - DONE, safely

Stale reminder confirmed present: `relative_period -7200`, `relative_to
due_date`, firing 16:00 - alongside the correct absolute 19:50 one. Note **both
were already in the past**, so this was cosmetic, not functional.

Done with the whole object, never a partial POST: snapshot -> filter one
reminder -> POST all 30 keys -> **independent GET** to read back. Priority still
**5**, all watched fields unchanged, and visibility confirmed by fetching his
actual landing view (pseudo-project `-2`): task 428 present at priority 5.

## Task 5 - relay hygiene - DONE

Orphan was task `mtdmu3qc-dar7r3`, claimed by `auto-flux-pavilion-show-abxx` at
`00:21:30`, whose process exited at `00:32:56` per autoseat's own child-exit
log. Its three asks had all been completed at the time; it just never posted a
result. The lease had expired, so `/result` 409d - had to `/claim` it over
first, then `/result`, then `/relayed`. **Claimed tasks across all of relay: 0.**

The 10 remaining `pending` are all correctly refused by autoseat and were
audited with `--once --dry --explain`: 5 in archived tabs, 1 `from:checklist`,
1 `from:relay-watchdog`, 4 already have coordinators dispatched.
