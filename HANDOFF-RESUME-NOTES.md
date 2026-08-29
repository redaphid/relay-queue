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

## Task 6 - COORDINATOR.md split into a skill - DONE (2026-08-29)

**Progressive-disclosure split.** `COORDINATOR.md` (54,023 B on disk / 53,641 B
LF-normalized) is now a **1,872 B stub**. The manual lives at
`D:\projects\.claude\skills\relay-coordinator\`.

**Location, and why:** coordinators are spawned with `cwd: 'D:\projects'`
(`tools/autoseat.js:439`), so `D:\projects\.claude\skills\` is the project
skills dir they actually see - sibling to the `hooks/coordinator-guard.js` that
already governs them. relay-queue has no `.claude/` at all.

**Byte counts (measured, not estimated):**

- `SKILL.md` **27,248 B** total = 601 B frontmatter (always on) + 26,647 B body
- `references/` **38,225 B** across **15** files (read only on demand)
- `validate-routing.js` 4,173 B
- stub `COORDINATOR.md` 1,872 B

Always-loaded manual cost drops **53,641 -> 27,248 B (-49%)**. The measurement
pass targeted ~21,900 B; it landed **~5.3 KB over**, and rules were NOT trimmed
to hit the number. The overage is the routing table (2,069 B, which the target
did not budget for) plus rule-bearing sentences kept in core against the
governing principle "never demote a rule whose omission causes silent harm":
the SSE keepalive/reconnect rules, the auto-seat seat-is-not-proof rule, and
the activity-row-is-not-liveness rule.

**No protocol was changed.** Every line was relocated verbatim by script
(`data/tmp/split-coordinator-*.py`, gitignored scratch) from explicit line
ranges, with asserted sub-line splits so a miss could not silently no-op - one
assertion did fire and caught a wrong line number. `data/tmp/coverage-check.py`
confirms every non-blank source line lands in the core or a reference; the only
10 absences are the old H1, 7 section headings replaced by reference titles,
and 2 paragraphs deliberately split across both tiers. Reproduce with
`git show <pre-split-sha>:COORDINATOR.md`.

**Three cross-references were retargeted** (they would otherwise dangle):
"see deployment hazards below" -> `references/briefing-deploy-hazards.md`;
"a source-change restart (see below)" -> same; "Different object from the
section above" -> `references/checklists-in-messages.md`. Nothing else reworded.

**Validator, proven red before green.** `validate-routing.js` checks ORPHAN (a
reference with no routing row - it would never be read), DANGLING (a row
pointing at a missing file), and BROKEN (a reference cross-referencing a file
that does not exist). Each was made to fail on purpose and watched: orphan file
added -> exit 1; `picks.md` renamed -> exit 1 with 2 problems; a cross-ref
mutated (`grep -c` confirmed 2 replacements applied, not a CRLF no-op) ->
exit 1. Restored -> exit 0.

**S6 mindmeld pre-check was NOT deleted.** Demoted to
`references/mindmeld-precheck-unexecuted.md` with a header recording that it has
never executed: `data/summaries/` does not exist on disk and has no git history,
and `coordinator-guard.js` refuses `curl` to `:3847` (rule `net-offrelay`,
allowlist is port 3901 only), so its prescribed action is impossible for its
intended reader. **Flagged for his decision** - delete, convert to briefing
material for a guard-exempt subagent, or widen the guard.

**Two things the measurement pass got wrong, both harmless:** it swapped the
Sharing/Safety byte counts (Sharing is 509 B, Safety 876 B - both kept in core
regardless), and it costed "S8 Scheduled Task supervision" at 9,184 B when that
heading's span also contains the auto-seat trigger allowlist and unwatched-seat
sweep. Only the 3,019 B that is genuinely Scheduled-Task ops became briefing
material; the rest is `references/autoseat.md`. The same bytes left the core
either way.

**RISK, needs his call:** the manual now lives in `D:\projects\.claude\`,
which is **not a git repository**. Git history still holds the old
`COORDINATOR.md`, but the current authoritative copy is unversioned on a box
that crashes. Candidate for the standing private-remote order.

---

## 2026-08-29: autoseat supervision - a wedged process is now detectable

**The reported fault was not real, and that is the finding.** autoseat PID
43952 was escalated as "alive but wedged for 16.7 hours", on the evidence that
its log had not been written since 04:59:20 UTC. It had not hung. It was
polling correctly the entire time.

What the silence actually was: `autoseat.js` prints `nothing to seat` only when
the text CHANGES (a deliberate anti-spam guard - an unconditional line would be
~8600 entries a day). The pending count sat at 11 from 04:59 until 21:44, so
there was genuinely nothing new to say. Proof it was alive, in order of
strength: its TCP sockets to :3901 churned (a fresh connection pair opened, used
and closed every ~10s - keep-alive is shorter than the poll, so a live poller
MUST reconnect); and when the count finally moved 11 -> 9 -> 7, it logged both
transitions within seconds.

**Do not read log silence as death here.** Settling this took socket forensics
precisely because no artifact on disk could distinguish "idle and fine" from
"wedged" - which is the real defect, and is what got fixed.

### What actually stranded his messages

Four human messages (including one `voice-conversation`) were dispatched-for at
04:13:24 and then never answered. `state.json` records a dispatch BEFORE the
spawn and never retracts it, and the selector refuses any task already in that
map. The three coordinators spawned at 04:13:24 wrote **0 bytes** and their
parent autoseat was killed ~04:30 (`PRE-RESTART-MARKER` at 04:30:47), which
took the children with it. So those messages became permanently un-seatable by
design, and sat until agents closed them by hand around 21:44 today.

**This is still open and is NOT what I fixed.** A dispatch whose coordinator
dies without answering should be retryable. The "never dispatch twice" guard is
load-bearing and deliberately argued in the source (it is what stops a
backlog storm), so widening it is his call, not a silent patch. The remaining 7
pending tasks are all correct refusals - archived conversations, or
`checklist`/`relay-watchdog` origins that are not human.

### What was fixed

`626ca4b` - autoseat writes `heartbeat.json` when a poll RUNS TO COMPLETION;
the supervisor treats a stale one as death, kills the pid and starts a fresh
one. Threshold 120s. The beat is NOT stamped on tick entry: `setInterval` keeps
firing behind a hung fetch, so an on-entry stamp would stay fresh through the
exact fault it exists to catch.

`043b09c` - both polls now carry an 8s `AbortSignal.timeout`. `fetch` has no
default overall timeout, so a relay that accepts a connection then goes quiet
parked a tick for 300s.

### Proven red before green, on the real process

    no heartbeat file      -> killed 43952, started 8900
    healthy, 3 runs        -> "healthy (heartbeat 1-2s old)", pid stable
    suspended, 107s stale  -> correctly NOT killed (under the 120s limit)
    suspended, 151s stale  -> killed 8900, started 40872
    fresh beat, foreign pid-> killed 40872, started 39380
    8s timeout             -> gave up at 8.1s; control without it hung past 25s

The wedge was simulated by SUSPENDING the process (NtSuspendProcess), not by
backdating the file - backdating only proves the supervisor can read a clock,
whereas suspending proves the property everything rests on: a process that is
alive but not working stops producing heartbeats.

### A trap that bit during this work

The restart note was appended to `autoseat.log` BEFORE the kill. The dying
process holds that log open through cmd's `>>` redirection, so `Add-Content`
threw - and under `$ErrorActionPreference = 'Stop'` that aborted the supervisor
mid-recovery: it identified the wedged process and then did nothing about it.
A worse bug than the one being fixed, found only by running it. Logging is now
best-effort and happens after the kill, and the supervisor refuses to start a
second dispatcher if the kill did not take.
