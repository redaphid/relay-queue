# HANDOFF — relay-queue / Flux Pavilion session, 2026-08-28/29

**Written by:** a one-shot subagent (`HandoffWriter`), dispatched specifically
to produce this file because the human interrupted himself while asking to
edit `COORDINATOR.md` directly and redirected to "write a HANDOFF.md instead."

**Status of this document:**
- **Part 1** is a factual narrative of what already happened. Everything in it
  either already shipped to `main` (verified below) or is a plain record of
  events — it is not asking anyone to decide anything.
- **Part 2 is a PROPOSAL. It has NOT been applied to `COORDINATOR.md` and
  nothing in it is adopted protocol.** Read it as "ready to evaluate and
  paste in if approved," not as "this is already how things work." This file
  does not modify `COORDINATOR.md` and nothing here should be read as if it
  had.
- **Part 3** is the open-loose-ends list for whoever (human or agent) picks
  this up next, including one that turned out to be live and urgent while
  this document was being written (see 3.2).

Every factual claim below (route names, file sizes, whether a process is
running, whether a model is pulled) was checked directly against this
machine while writing this document, not carried over unverified from the
brief that produced it. Where something could not be confirmed, it says so
explicitly rather than presenting a guess as fact.

---

## Part 1 — Session narrative

### 1. The trigger

The human asked the primary coordinator session to close out old relay
coordinators and start a new one for a Flux Pavilion show to-do list. All 16
existing relay conversations were checked and found already unassigned (0
pending, 0 claimed) — every seat had emptied itself; nobody was actually
running in any of them. 15 were archived (reversible: `POST
/conversations/<id> {"archived":false}`). A new conversation, **"Flux
Pavilion show prep"** (id `mtdlndrh-wiabxx`), was created with agent seat
`FluxPrep`.

### 2. First dispatch, and the gap

`FluxPrep` was dispatched as a **one-shot Agent-tool subagent** to research
the show (venue, date, tickets) and build a pre-show checklist. It found the
date via Vikunja Inbox task #254 (mindmeld had the venue — Sunbar Tempe — but
never the date), confirmed tickets were already purchased via Tixr, posted a
12-item pinned relay checklist — then finished and its whole process exited.

**Failure mode:** a one-shot Agent-tool dispatch is not a persistent
listener. Once `FluxPrep` returned, nothing was watching that conversation.
The human sent 12 voice messages over the next ~9 minutes with zero response,
then asked the primary coordinator directly why nothing had answered.

Root cause, as explained to him at the time:
- (a) the subagent treated "build the checklist" as the complete job rather
  than staying attached, and
- (b) the coordinator never armed a `Monitor` on the relay SSE stream to
  notice new messages after dispatch, per `COORDINATOR.md`'s own **"Watch,
  don't poll"** section (that section still reads, verbatim, in the copy on
  `main` today: *"Use the Monitor tool against the SSE stream instead of a
  sleep-loop"*).

### 3. The Monitor cost question

The human asked: is arming `Monitor` on a relay SSE endpoint free while idle?

**Answer given, worth preserving:** yes — `Monitor` is a background
shell/process outside the model; tokens are spent only when a line matches
and fires a notification, not while idle.

**Critical caveat, restated precisely because it is the crux of the whole
session:** a `Monitor` only survives as long as the process holding it stays
resident. A dispatched subagent that returns and exits takes any `Monitor` it
armed down with it. **This is exactly why the first `FluxPrep` going quiet
was fatal** — even if it had armed a `Monitor` before finishing, that
`Monitor` would have died with it.

### 4. The real feature: seat-unwatched auto-detection

The human asked for relay-queue itself to detect "nobody is actually
listening on this conversation's SSE stream," independent of the `agent`
field — because `agent` stayed `"FluxPrep"` the entire ~9-minute gap even
though the process behind it was dead.

This was built in a worktree (`D:\projects\relay-queue-sse-autoseat`, branch
`sse-listener-autoseat`) and **is already merged to `main` and live** —
verified directly while writing this document, not carried over from the
task brief:

- `git log` on `main`: **HEAD is `6315b32`**, `Merge: seat a coordinator when
  nobody is listening, not just when agent is null` — confirmed to be the
  actual current tip of `main`.
- Backup tag `pre-sse-autoseat-merge` exists and resolves to `cec99ff`
  (`Merge: record who left when an agent releases its own chair`) — confirmed
  by `git log -1 pre-sse-autoseat-merge`, matches the pre-merge base recorded
  at the time.
- `COORDINATOR.md`'s own **"Auto-seat"** section on `main` already documents
  this mechanism in detail (added in commit `462e9f6`, "Document the
  seat-unwatched mechanism in COORDINATOR.md") — this document does not
  restate that section; read it there. Summary of the mechanism: the server
  tracks live SSE subscriber counts per conversation (`convListeners`),
  derives `agentState.seatUnwatched` on the existing `GET /conversations`
  response using a new `SEAT_UNWATCHED_MS` (defaults to the existing
  2-minute `NUDGE_PENDING_MS`, gated on there being a real pending message),
  and `tools/autoseat.js`'s `selectSeats()` treats an occupied-but-unwatched
  seat the same as an empty one.
- Self-test `tools/seat-unwatched-selftest.js` exists and (per the commit
  history) proves the guard goes red via in-memory mutation of `server.js` —
  this repo's standing bar, since `sed -i`/`perl -0pi` silently no-op against
  this box's CRLF files.
- **Confirmed working live, on the real case that motivated it:** the Flux
  Pavilion tab itself was later found `seatUnwatched:true` and a fresh agent
  (`auto-flux-pavilion-show-abxx`) was auto-seated into it without any human
  or coordinator action, within about an hour of the merge shipping. This is
  visible directly in the conversation's own message history (see message
  index 24, `mtdmudde-llarew`, timestamp `2026-08-29T00:18:46.706Z`): *"auto-
  flux-pavilion-show-abxx seated - reading the tab now, will report back
  shortly."*

### 5. Real-world chaos in the same tab

While the SSE-autoseat feature was being built, the Flux Pavilion tab itself
had **three coordinators overlap**, a direct violation of `COORDINATOR.md`'s
**"One coordinator, one tab"** rule:

- `FluxPrep` was redispatched to clear the 12-message backlog, went quiet
  again ("died at 4:50" per a peer agent's own words in the thread).
- `FluxPrep2` appears to have been separately dispatched or self-spawned
  around the same time and worked the same backlog concurrently. Verified
  directly in the message thread (`GET /messages?conversationId=mtdlndrh-
  wiabxx`): message `mtdmt5jj-u01poq` (`FluxPrep2`, `2026-08-29T00:07:29Z`)
  opens with *"New agent here (FluxPrep2). Last one died at 4:50 and dropped
  your messages."* — followed shortly by `mtdn37pd...` (`FluxPrep2` again,
  `00:16:42Z`): *"Heads up: two agents were running in here at once, so you
  may have seen doubled-up replies. Cleaned up - there is now one set of 8
  tasks, no duplicates."*
- Consequence: duplicate Vikunja tasks were created, some at priority 2–3 —
  below the human's `priority>=4` landing-view filter, meaning he would never
  have seen them. `FluxPrep2` detected and cleaned this down to one clean set
  of 8 tasks at priority 4–5.
- The new `auto-flux-pavilion-show-abxx` (from the SSE-autoseat feature)
  **then also joined the same tab afterward** — a fourth agent in the same
  conversation across the session.

**Token cost, and the direct motivation for Part 2:** the human asked *"How
could what we are doing possibly take 70k tokens?"* (message `mtdmt5jj-
u01poq`, `2026-08-29T00:17:49.903Z`). `auto-flux-pavilion-show-abxx` answered
(message `mtdmysef-1ok40d`, `00:22:12.807Z`), and this document independently
re-verified the headline number in that answer rather than trusting it
as-is:

> *"Almost none of the 70k was your actual to-do list. It was boot tax, paid
> 3 times. Every agent in this tab loads 64 KB of docs before it does
> anything: COORDINATOR.md - 42 KB..."*

**Verification:** the "42 KB" figure was accurate **for the version of
`COORDINATOR.md` that was actually live at 00:22 UTC** — at that instant,
`main`'s `COORDINATOR.md` was still at commit `1dff1a3`, which measures
**41,825 bytes / 6,369 words** (`git show 1dff1a3:COORDINATOR.md | wc -c`).
**As of this document being written, two further commits have landed on top**
(`4c82409` "Seat a coordinator when he SPEAKS," and `462e9f6` "Document the
seat-unwatched mechanism") and the file now measures **45,877 bytes / 6,935
words** (`wc -c COORDINATOR.md` / `wc -w COORDINATOR.md`, run directly against
the current `main` checkout). Use **45,877 bytes (~44.8 KiB / ~45.9 KB
decimal)** as the current number if you need to cite it going forward — it
will keep growing as more sections are added, which is itself relevant to
Part 2 below.

### 6. The alarm chain for the nap

A real alarm chain was built for a 30-minute nap: Vikunja task **#441**
("WAKE UP - Flux Pavilion tonight," priority 5, Inbox), a Windows Scheduled
Task **`WakeAlarm-FluxPavilion`**, and 3 scheduled ntfy pushes (IDs
`X2m41bMI8Kui`, `keHN12JRNgn3`, `4yS5KZQtfCn9`). Per the thread (message
`mtdnc0bp-g5qg8k`, `00:32:29Z`) it was armed for **5:48 PM local** through
three independent legs: the Vikunja task's own reminder (picked up by the
already-running `vikunja-reminders` container and pushed via ntfy at urgent
priority), the ntfy server-side delayed pushes directly, and the Windows
Scheduled Task (pushes ntfy 3x, flashes lights orange, speaks aloud).

The human later said (message `mtdo1noe-ztq77d`, `00:52:26Z`): *"Stop the
alarm. I didn't put the last load in the dryer. It'll be at least 2 more
hours now."* The primary coordinator (not a subagent, deliberately, to avoid
further agent sprawl in an already-crowded tab) verified task #441 was
`done:true` with a one-shot (non-repeating) reminder, verified via a small
fast subagent that the Windows Scheduled Task trigger was genuinely one-time
(already fired, no repetition, left enabled since harmless), and rescheduled
the related laundry task (Vikunja **#428**, "move wash to dryer") to a new
due date/reminder about 2 hours out.

**This compresses the gap** between dryer-done and his planned 8:15pm
departure to roughly 20 minutes. The coordinator flagged this to him and
offered to push the departure later instead, since doors are 9pm and the show
runs to 2am (there is slack). **See Part 3.1 — this document could not
confirm he ever answered that specific offer.**

At `01:01:21Z` (message `mtdod4wx-txegcw`), `FluxPrep` posted: *"30 minute nap
alarm just fired (spoken). Time to get ready for Flux Pavilion."* — confirming
the alarm worked end to end.

### 7. Direct-to-human handling, and the redirect to this document

The human then directly asked the primary coordinator (not a new subagent) to
speak a wake-confirmation aloud via `speak` and post the relay confirmation —
explicitly exercising a "tell me directly, I'll handle it myself" approach
instead of spawning more agents. Both actions succeeded (spoken through
"Speakers (Echo Studio-15N)"; message `mtdod4wx-txegcw` posted and relayed).

The human then raised the reliability ideas that became Part 2 of this
document, said **"the system keeps stopping,"** asked to update
`COORDINATOR.md` directly — then interrupted himself twice and settled on:
write a handoff document instead, via a subagent, not directly. That
subagent is this one.

---

## Part 2 — PROPOSED dispatch-protocol change (NOT applied to COORDINATOR.md)

**Restating plainly: nothing below is adopted. `COORDINATOR.md` on `main` is
unchanged by this document.** This section exists so the idea can be
evaluated and, if approved, pasted into `COORDINATOR.md` roughly as written.

### 2a. Keep-alive / self-wake — researched answers, not speculation

**Question 1: "Can Vikunja be scheduled to wake/stimulate relay-queue every 5
minutes?"**

Verified against this machine's own Vikunja instance
(`GET http://localhost:3456/api/v1/info` → `"webhooks_enabled":true`) and
against Vikunja's own webhook documentation (vikunja.io/docs/webhooks,
vikunja.io/help/webhooks — via web search, since this machine's Vikunja
instance does not locally host its own docs):

- **Vikunja's native webhooks are event-triggered, not time-triggered.**
  Confirmed event types: `task.created`, `task.updated`, `task.deleted`,
  `task.comment.created` (project-level webhooks), plus, per third-party MCP
  documentation (not independently confirmed against vikunja.io's own docs —
  see the unverifiable list in 2c), user-level webhooks for "a reminder
  firing" or "a task becoming overdue." **There is no generic "call this URL
  every N minutes, unconditionally" primitive in Vikunja itself.**
- **The closest existing mechanism is already running on this box:** the
  `vikunja-reminders` Docker container (`docker inspect vikunja-reminders`
  confirms image `node:22-alpine` running `/app/reminders.js`, bind-mounted
  from `D:\projects\vikunja\reminders`). Reading `reminders.js` directly:
  it polls Vikunja every `POLL_INTERVAL_SECONDS` (currently `60`, i.e. every
  60 seconds — not 5 minutes, but the same shape), and when a task's due
  reminder fires, it **already POSTs directly into relay**
  (`${cfg.relayUrl}/messages` with `conversationId: cfg.relayConversationId`
  — confirmed at `reminders.js:223-259`). Live logs confirm this actually
  happens: `"relay push queued: message mtdrjagz-u3de2n -> conversation
  mtazdjld-rsrxl9"`.
  - **This is Vikunja-reminder-to-relay, which is close to but not the same
    as a generic heartbeat.** Two real gaps: (1) it only fires when a task's
    reminder is actually due, not on an unconditional clock — most 60-second
    polls do nothing (`"0 fired, 1 already sent"` is the typical log line);
    (2) `RELAY_CONVERSATION_ID` is a single hardcoded env var
    (`mtazdjld-rsrxl9` currently), so it always targets one specific
    conversation, not "whichever tab needs waking."
  - **A real path to the human's ask exists without new code:** create a
    Vikunja task with a repeating reminder (Vikunja supports recurring
    due dates), pointed at whichever conversation needs it. The existing
    sidecar would then, in effect, ping relay on that cadence. This still
    goes through the polling container, not a native Vikunja scheduled
    webhook — flagging that distinction because "does X support Y" was the
    literal question asked, and the honest answer is "not directly, but the
    thing already glued to it can be made to do the equivalent."

**Question 2: "Will relay's API support that?"**

Read `server.js` directly rather than assuming. Answer: **an external ping
every 5 minutes would not change relay's own self-maintenance behavior at
all**, because that behavior does not depend on external traffic:

- `WATCH_TICK_MS` (`server.js:3044`) defaults to **15000 (15 seconds)**.
- `pushWatch` — which calls `sweepVacantChairs()` (the 45-minute vacancy
  sweep) and `nudgeStalePending()` (the "unclaimed pending for >2 min" nudge)
  in sequence, confirmed at `server.js:3365-3366` — is registered with
  `setInterval(pushWatch, WATCH_TICK_MS).unref()` at `server.js:8056`.
- **This means both mechanisms already run on their own internal clock,
  every 15 seconds, with zero dependency on anyone hitting any route.** An
  external `GET /health` or `GET /conversations` every 5 minutes would be
  **20x less frequent** than what already happens on its own, and would not
  cause either function to run any more or less often.
- What an external 5-minute ping **would** accomplish: nothing found in this
  codebase suggests relay-queue's process is ever at risk of being reaped for
  idleness (it runs as a plain long-lived process — verified a
  `node.exe ... server.js` process is genuinely resident on this host, not a
  scale-to-zero container), so there is no "keep it warm" case to make here
  either. **No route or existing mechanism in `server.js` would benefit from
  this specific proposal** as literally stated. If there is a reason to want
  it, it is not one this document could find evidence for.

**Question 3: "Can Monitor be used on a relay endpoint so a coordinator wakes
up?"**

Yes, and this was already established and shipped by the time this document
was written — `COORDINATOR.md`'s own **"Watch, don't poll"** section
documents the exact pattern (`curl -N -s
"http://127.0.0.1:3901/events?conversation=<id>"`, wrapped in a reconnect
loop, filtered for real content lines, armed as a `persistent:true` Monitor).

**Restating the caveat precisely, because this is the one distinction the
whole session turned on:** *"keeps a live coordinator awake"* and *"revives a
dead one"* are different problems.

- `Monitor` solves the first: a resident, long-lived coordinator session gets
  woken on new SSE events instead of polling.
- `Monitor` does **nothing** for the second: a one-shot subagent that has
  already returned and exited has no process left for the `Monitor` to wake
  — the `Monitor` dies with the process that armed it (see Part 1.3).
- The second problem is what the seat-unwatched / auto-seat feature (Part
  1.4, already shipped) is for. It does not need a `Monitor` at all — it is
  a server-side check plus a host-process poller (`tools/autoseat.js`)
  deciding to dispatch a **new** process into the vacated seat.

### 2b. Context-loading pipeline before dispatching a new coordinator

Written in the style of a ready-to-paste `COORDINATOR.md` section, **if this
is approved** — it is not applied here.

> ---
> ### Before dispatching into an existing tab: check mindmeld first
>
> 1. **Check whether the conversation is already indexed in mindmeld** before
>    dispatching a coordinator with a full raw-thread read. Mindmeld answers
>    plain HTTP with no auth at `http://localhost:3847`. The real search route
>    is **`GET /api/search`** (not `/search`, not `/api/query` — verified
>    against `docs/openapi.yaml`, which is the same file bind-mounted live
>    into the running `mindmeld-mcp` container, so this is the live contract,
>    not stale repo source). Required param `q`; useful params `mode`
>    (`text` is fastest and doesn't need embeddings — reads Postgres directly;
>    `hybrid` is default and can lag hours behind on very recent data),
>    `limit`, `dataClass`, `since`, `cwd`.
>
> 2. **`dataClass` defaults to `coding` only.** This was verified — and
>    **corrects an assumption worth stating plainly: relay-coordinator work
>    does NOT need a special `dataClass`.** A relay coordinator IS a Claude
>    Code session running on this machine, and mindmeld indexes it exactly
>    like any other Claude Code project session, tagged `source:"claude_code"`
>    and `dataClass:"coding"` — **the default**. Confirmed empirically: a
>    plain default-dataClass text search for `"Flux Pavilion"` against
>    `http://localhost:3847/api/search?q=Flux%20Pavilion&mode=text` returned
>    real hits from actual coordinator sessions
>    (`source:"claude_code","dataClass":"coding"`) with no special filter
>    needed. The `dataClass=personal` concern is real for SMS/phone/meeting
>    data, not for relay-coordinator sessions specifically.
>
> 3. **If the conversation IS indexed:** brief the new coordinator to pull
>    context from mindmeld's search/session results instead of a full
>    `GET /thread?conversation=<id>` or `GET /messages?conversationId=<id>`
>    read. This is a direct fix for the 42–46 KB-`COORDINATOR.md`-plus-full-
>    thread boot tax measured in Part 1.5 — every extra agent that reads the
>    full thread pays for it again.
>
>    **Real gap, stated honestly rather than glossed over:** there is no
>    field tying a mindmeld session to a specific relay `conversationId`.
>    You would have to search by content/keywords and infer which
>    session(s) correspond to the tab you care about — and this session's own
>    Flux Pavilion tab is a worked example of why that's unreliable: **three
>    separate coordinators** (`FluxPrep`, `FluxPrep2`,
>    `auto-flux-pavilion-show-abxx`) each ran as their own Claude Code
>    session against the same relay conversation, so mindmeld would hold
>    **three separate, un-linked session records** for one relay tab, not
>    one unified history.
>
>    **Second real gap:** mindmeld's own summarization pipeline
>    (`mind-meld/CLAUDE.md`, "Diagnosing throughput" section) explicitly
>    excludes a session that ended less than 30 minutes ago from both the
>    embedding queue and the pending-count on both sides — a live,
>    still-active tab's most recent turns will not be searchable in mindmeld
>    yet, no matter what `dataClass` is used. **This step only helps for
>    conversations that have already gone quiet for a while; it does nothing
>    for the hot, currently-worked tab a coordinator is being dispatched
>    into right now** — which was true of the Flux Pavilion tab itself for
>    most of this session.
>
> 4. **If NOT indexed (or too fresh to be indexed):** summarize the raw relay
>    thread with local Ollama, model **`qwen3:4b-instruct`** — note the exact
>    tag; the bare tag `qwen3:4b` named in the original ask is **not** what is
>    pulled on this machine (`ollama list` shows `qwen3:4b-instruct`, 2.5 GB,
>    pulled 2 weeks ago — no plain `qwen3:4b`). Using this exact model is not
>    a new dependency: **mindmeld's own summarization pipeline already uses
>    it** (`mindmeld-mcp`'s container env: `SUMMARIZE_MODEL=qwen3:4b-instruct`
>    — confirmed via `docker inspect mindmeld-mcp`), so this reuses an
>    existing, already-proven-working model rather than introducing a second
>    one to keep pulled and maintained.
>
>    **Route the call through the existing GPU gate, not straight to
>    Ollama.** Real Ollama binds `0.0.0.0:11434`; the gate (`ollama-proxy`,
>    `D:\Projects\ollama-proxy\supervise.ps1`) listens on **11434 externally
>    is real Ollama, 11436 is the gate** — confirmed: `supervise.ps1` sets
>    `$env:PORT = "$Port"` with `$Port` defaulting to `11436`, and
>    `mindmeld-mcp` itself is configured with
>    `OLLAMA_URL=http://host.docker.internal:11436` — i.e. mindmeld's own
>    summarizer already goes through the gate, not around it. A new consumer
>    should do the same, to respect the existing "don't compete with gaming
>    or ComfyUI" policy the gate exists to enforce.
>
>    **Operational risk, not a reason to skip this but a reason to design for
>    failure:** this machine has a documented history of a single stuck
>    Ollama client starving the one generate slot (`OLLAMA_NUM_PARALLEL=1`),
>    and of a resident VLM model (`qwen3-vl:8b`) holding enough VRAM to
>    collapse unrelated GPU work to a crawl. A summarization call added here
>    should time out and fall back to a raw-thread read rather than block a
>    coordinator dispatch indefinitely — it must fail open, the same way
>    mindmeld's own interactive search path already does
>    (`getInteractiveOllamaClient()`, one attempt, bounded timeout, falls
>    back to full-text with `degraded` rather than hanging).
>
>    Write the summary to **`data/summaries/<conversationId>.md`** under this
>    repo. Reasoning: `relay-queue`'s `data/` directory is already the
>    established, fully-`.gitignore`d location for exactly this kind of
>    runtime-generated, non-source artifact (it already holds
>    `events.jsonl`, `images/`, etc. — confirmed via `.gitignore`, which
>    ignores all of `data/`), so this follows an existing convention rather
>    than inventing a new one, and never risks polluting git history with
>    generated summaries.
>
> 5. **Dispatch the new coordinator using that summary file as its context**
>    instead of the full tab history.
>
> 6. **Only take this detour for a "longish" conversation.** Proposed
>    threshold: **20 messages**, read from the `messages` count already
>    returned by `GET /conversations`. Reasoning, shown so the number can be
>    revisited rather than treated as received wisdom: the raw Flux Pavilion
>    thread (31 messages) is 17,185 bytes as JSON — about 554 bytes
>    (roughly 140 tokens) per message on average. `COORDINATOR.md` alone
>    costs roughly 11,500 tokens per boot at its current size (45,877 bytes
>    ÷ ~4 bytes/token). A thread has to run into the dozens of messages
>    before its own read cost rivals the manual's fixed cost — so 20
>    messages (≈2,800 tokens of thread) is the point where the detour
>    (an extra Ollama call, a file write, a file read) plausibly starts
>    paying for itself, comfortably below where Flux Pavilion's own 31-
>    message thread sat when this became a real, measured problem. **This is
>    a reasoned estimate, not a benchmarked cutoff** — no direct measurement
>    of `GET /thread`'s actual token cost at varying sizes exists yet; see
>    2c.
> ---

### 2c. Explicit status and unverifiable items

**This entire Part 2 is a proposal. It has not been applied to
`COORDINATOR.md`.** State this to anyone who reads this file out of context.

**Could not verify with confidence, flagged rather than presented as fact:**

- Vikunja's user-level "reminder firing" / "task overdue" webhook events
  (2a) are documented only via a third-party MCP server's docs surfaced in
  a web search — not independently confirmed against `vikunja.io`'s own
  webhook reference page's exact event list. Treat the project-level events
  (`task.created`/`updated`/`deleted`/`comment.created`) as the confirmed
  set; treat the user-level reminder-webhook claim as plausible but
  unconfirmed.
- Whether Ollama would actually respond promptly to a live `qwen3:4b-
  instruct` summarization call **right now** was not tested — this document
  deliberately did not fire a real generate call, to avoid taking a GPU
  slot from other work while doing documentation research. Model presence
  (`ollama list`) was confirmed; live responsiveness under the gate was not.
- The 20-message threshold (2b.6) is a reasoned estimate from one data
  point (the Flux Pavilion thread), not a benchmark across multiple
  conversation sizes.
- Whether any *other* mindmeld ingestion path (outside the "relay
  coordinator is a Claude Code session" case that was actually tested)
  would classify relay content under a non-`coding` `dataClass` was not
  checked, because no such path currently exists to test.

---

## Part 3 — Open loose ends for whoever picks this up next

> **RESOLVED 2026-08-29T04:2x UTC — do not redo these.** Every item in Part 3
> (3.1 excepted) was picked up and closed by agent `HandoffResume`, and Part 2
> was evaluated claim-by-claim and partially applied to `COORDINATOR.md`.
> **Read `HANDOFF-RESUME-NOTES.md` in this repo before acting on anything
> below** — it records what was applied, what was deliberately left out and why,
> and what still needs a decision. 3.1 (the departure-time question) was moot by
> then: he was already out at the show.

### 3.1 — Did he ever answer the departure-time question?

Part 1.6 describes the coordinator flagging that the rescheduled dryer time
compresses the gap to his planned 8:15pm departure to ~20 minutes, and
offering to push the departure later instead. **This document read the full
31-message Flux Pavilion thread end to end and found no explicit answer to
that specific offer.** The closest thing is his most recent message (see
3.2 below): *"Ok. I have my outfit. Don't need a dryer... "* — which appears
to make the tight-timeline problem moot by removing the dryer dependency
entirely, but that is this document's inference, not his direct answer to
the question as posed. **If the departure-time question mattered, it was
most likely resolved by voice or directly with the primary coordinator
outside what got logged to relay — ask him directly rather than assume it's
settled.**

### 3.2 — URGENT, discovered live while writing this document

**As of `2026-08-29T02:48 UTC`, the Flux Pavilion tab (`mtdlndrh-wiabxx`) has
`agent: null`, `agentLeftReason: "presumed-gone"`, and one PENDING, UNANSWERED
message from the human:**

> `mtdroh1h-mxwz21`, `2026-08-29T02:34:09Z`, `from: "web"`: *"Ok. I have my
> outfit. Don't need a dryer. Showered, nails clipped. Ellie is going out
> drinking in ~45m"*

`from: "web"` is in `autoseat.js`'s `HUMAN_ORIGINS` allowlist, so this
message should trigger auto-seating. **It did not, for at least 14 minutes at
time of checking, because `tools/autoseat.js` is confirmed NOT currently
running as a host process** — a full scan of every `node`/`pwsh`/`python`
process on this machine (`Get-CimInstance Win32_Process`) found nothing
referencing `autoseat` anywhere in its command line; the only relevant
`node.exe` found is relay-queue's own `server.js`.

This resolves a discrepancy flagged during the session (`autoseat.js` was
checked once and found not running, then evidently active minutes later when
it successfully auto-seated `auto-flux-pavilion-show-abxx` — see Part 1.4):
**`autoseat.js` is not a persistent, boot-supervised service on this
machine.** It was apparently started by hand at some point during this
session, worked exactly as designed once, and is not running now. **This is
a live, current instance of the exact "the system keeps stopping" complaint
that motivated this whole document** — not a hypothetical.

Two things worth doing, for whoever reads this next:
- **Decide whether to answer the pending Flux Pavilion message directly** —
  it has been sitting unanswered since 02:34 UTC.
- **Consider whether `tools/autoseat.js` needs real supervision** (a
  Scheduled Task, a restart wrapper, anything that survives a closed
  terminal) instead of being something a human or coordinator has to
  remember to start. Right now its liveness is exactly as fragile as the
  one-shot-subagent problem this whole session was about — just one level
  up the stack.

*(This document intentionally does not restart `autoseat.js` or answer the
pending message itself — that would be acting outside the documentation
task this file was written for. Flagging it here is the deliverable.)*

### 3.3 — Worktree cleanup

`D:\projects\relay-queue-sse-autoseat` (branch `sse-listener-autoseat`, HEAD
`462e9f6`) still exists on disk — confirmed via `git worktree list`. It is
fully merged into `main` (at `6315b32`) and is safe to remove:

```sh
git worktree remove ../relay-queue-sse-autoseat
git branch -d sse-listener-autoseat
```

(Per `COORDINATOR.md`'s own deployment-hazards section: check
`Get-Item <path> -Force` for a junctioned `node_modules` before any recursive
delete, in case one exists in this worktree — this document did not check
that specifically.)

### 3.4 — Vikunja task #428's stale reminder

Per the primary coordinator's own account (not independently re-verified by
this document — no Vikunja write/read tooling was exercised for this pass):
task #428 has one harmless-but-stale reminder entry (a relative "-2h from
due date" reminder that now points at a time already in the past) alongside
the new correct reminder at 19:50–07:00. Left alone because removing it
requires a reminder id the tool didn't expose cleanly. Not urgent — noted so
nobody is confused seeing two reminder entries on that task.

### 3.5 — The autoseat.js discrepancy (see 3.2 — now resolved, not just flagged)

The original ask for this document included resolving whether `autoseat.js`
was really running. **It is not, as of this writing** — see 3.2 for the full
finding and evidence. Anyone relying on auto-seating working right now should
check `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match
"autoseat" }` (or equivalent) before assuming it is armed.
