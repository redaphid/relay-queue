# Retrospective — multi-agent orchestration, night of 2026-08-07/08

Written to make the next night better, not to record this one. The failures are
the useful part; they are stated plainly and with mechanism, because a failure
without a mechanism cannot be designed against.

**Sources.** The relay queue's own append-only log (`GET /tasks`, 312 messages;
`GET /conversations`), the git history of `COORDINATOR.md` and `WORK-LOG.md`
(the rules were written *during* the night, so their commit order is itself a
record of what was learned when), the structured postmortem in mindmeld session
6247, and the coordinator's first-hand account of what it did.

All times local (UTC−7). No message content from the user's phone is reproduced
here; incidents are described structurally.

---

## 1. Timeline

| Local time | Event |
|---|---|
| 14:56 | First message in `main`. Answers are manual and slow; no watcher yet. |
| 16:38 | Watcher loop armed on `main`. Answer latency drops from ~11 min to seconds. |
| 16:40 | **First probe overwrite** — a real question permanently answered with `test — does a simple body work?` |
| 18:40 | A message is claimed, then orphaned by a dying session. It is not answered for **3h14m**. |
| 20:32 | Multi-conversation model lands; a second conversation is opened as a test. |
| 20:39–22:27 | `Test` conversation: two agents (`coordinator-2`, `juno`) share one conversation. Median answer 4m13s — the worst of any staffed conversation. |
| 21:57 | Third conversation opened with a dedicated coordinator (`Romeo`). |
| 22:19 | Romeo is stopped mid-task. Its claimed message rots **32m** and trips the watchdog. |
| 22:50 | Fourth conversation opened with a dedicated coordinator + its own watcher. It becomes the best-performing thread of the night (median 44s over 87 messages). |
| 01:14–01:17 | `COORDINATOR.md` written and then amended twice, in-night, with the protocol traps as they were hit. |
| 02:14–02:27 | Replacement coordinator on conversation 3 **stalls with two unanswered messages**; the router pokes it three times, then answers in its tab itself and hands the work to a fresh agent. |
| 02:32 | Last message. ~11h35m elapsed, 312 messages. |

Volume was not flat: 14:00–19:00 ran 5–14 messages/hour, then 20:00–01:00 ran
37–48 messages/hour. Every structural failure below happened during the busy
window, which is the window that matters.

---

## 2. The numbers

Measured over **human-origin messages only** (`from` ∈ `web`, `voice`,
`voice-conversation`; n=276, 274 answered). Agent-posted messages are excluded
because they are self-answered in the same second and would halve the median
dishonestly.

### Response latency (`ts` → `resultTs`)

| | |
|---|---|
| median | **1m15s** |
| p75 | 2m14s |
| p90 | 4m38s |
| p95 | 7m13s |
| p99 | 14m37s |
| worst | **194m05s** (3h14m) |
| mean | 2m52s |

Distribution: 121 under a minute, 105 at 1–3 min, 37 at 3–10 min, **9 at
10–30 min, 2 over 30 min**.

Latency decomposes into `ts`→`claimedAt` (time to notice) and
`claimedAt`→`resultTs` (time to answer). In `main`, median notice was 40s and
median answer 38s — **noticing cost as much as answering**. In the
best-performing conversation the two were fused into one call, and median
notice was the whole latency.

### Per conversation

| Conversation | Staffing | n | median | p90 | worst |
|---|---|---|---|---|---|
| travel logistics | 1 dedicated coordinator + own watcher | 87 | **44s** | 1m22s | 8m35s |
| `main` (router) | 1 agent, also routing everything else | 160 | 1m27s | 3m59s | 194m05s |
| `Test` | 2 agents sharing one conversation | 22 | 4m13s | 7m01s | 12m04s |
| mindmeld | 1 coordinator, stalled twice | 7 | 4m26s | 5m52s | 32m10s |

**The staffing pattern predicts the latency.** One agent owning one conversation
with its own watcher was 2× faster than the router that owned a conversation
*and* coordinated, and 6× faster than two agents sharing a conversation.

### The number that matters more than the median

**148 of 276 human messages (54%) arrived while at least one earlier message in
the same conversation was still unanswered.** 59 arrived with two or more
already waiting; peak backlog depth was 8.

The median says each individual answer was quick. The backlog says he was
talking faster than the system answered for most of the night, and the felt
experience of a thread is set by the backlog, not by the median. **This is the
metric to optimise and the one nothing currently reports.**

### Who answered what

| Agent | Human msgs answered | median | worst |
|---|---|---|---|
| the travel coordinator | 86 | 44s | 8m35s |
| the router (as `Zora`) | 80 | 1m50s | 7m11s |
| the router (as `communicator`) | 76 | 1m03s | 194m05s |
| `juno` | 7 | 2m20s | 7m01s |
| `Romeo` | 5 | 4m26s | 32m10s |
| `coordinator-2` | 3 | 10m32s | 12m04s |

### Data-integrity findings in the log itself

- **3 real questions are permanently answered with probe text** (`test`,
  `probe`, `test — does a simple body work?`), all three marked `relayed: true`.
- **4 tasks have `relayedAt` earlier than `resultTs`** — marked delivered before
  an answer existed. Three of those four are the probe overwrites above.
- **0 tasks currently sit `done` with `result: null`** — the one that did was
  caught and repaired in-night. It was only caught by luck.
- **36 messages (12% of the thread) were posted by agents**, wearing the `user`
  role because the server sets `role` itself. 17 were agents talking to the
  human; **19 were agents talking to each other**, routed through the human's
  thread because there is no other channel.

---

## 3. What worked, and why

**Front-loading settled findings into every brief.** Briefs that carried *the
constraint that decides the design* — Workers cannot spawn a process, whisper is
CPU-only, `amber` returns 400 — produced better work than briefs that only
stated the goal. No agent re-derived any of them. Cost of the constraint in the
brief: one sentence. Cost of re-deriving it: measured in this repo at 30+ minutes
per agent.

**Explicit file ownership.** "You own `docs/openapi.yaml` and nothing else."
Four concurrent agents in one repo, zero lost edits. The one near-collision that
did happen was the coordinator against *its own* agent, in a case where nobody
had declared ownership — which is the exception that proves it.

**Worktree isolation.** When a privacy incident surfaced in a working tree, the
implementation agent was *structurally* incapable of being affected, because it
had branched. This is the difference between a convention and a property.

**Independent verification of agent claims.** At least two agent reports were
confidently wrong: one reported 4 of 5 whisper models down (all five were up —
its test ran outside the docker network), another took a retry budget from a
README that the code contradicted by a full minute. Both would have been relayed
to the user as fact. **Verification caught two false statements in one night;
assume the base rate is not zero.**

**Agents correcting the brief.** The sessionization brainstorm overturned three
premises in the coordinator's own brief; the implementation agent corrected two
more. This only happened in briefs that explicitly invited disagreement. It is
cheap to ask for and it worked every time it was asked for.

**Writing traps down at the moment of discovery.** `COORDINATOR.md` was amended
twice inside three minutes (01:14, 01:17) with protocol traps as they were hit.
It demonstrably worked: a newly-launched coordinator later hit the "agents cannot
initiate a message" constraint and handled it correctly *from the document*,
without rediscovering it. This is the highest-leverage thing done all night.

**One agent, one conversation, own watcher.** 44s median over 87 messages. Every
other staffing arrangement was slower.

---

## 4. What failed, with mechanism

### 4.1 No agent can wake itself — the defining limitation

Monitor events are delivered only when a turn *starts*. An idle agent has no
turn, so its own watcher cannot rouse it; six alarms once fired on schedule and
all six arrived batched on an external poke.

Consequences, both observed: a coordinator stalled with **two unanswered
messages** while the router poked it three times, and the router eventually
answered in the coordinator's own tab and reassigned the work to a fresh agent.
Earlier, a different coordinator was stopped mid-task and its claimed message
rotted 32 minutes.

The generalisation: **nothing inside a Claude session outlives the session, and
nothing inside an idle session can start itself.** Every liveness guarantee in
this system currently rests on some *other* live session choosing to poke.

### 4.2 Completion notifications go to the spawner, not the owner

A delegated implementation agent reported back to the coordinator that *spawned*
it rather than the coordinator that *commissioned* the work. The commissioning
coordinator would have waited indefinitely for a result that had already
arrived somewhere else. There is no routing layer on completion — the callback
target is an artefact of who called `Agent`, not of who needs the answer.

### 4.3 The coordinator drifted into doing the work itself

Corrected mid-session by the user: *"Remember: you delegate. Don't act."*

Mechanism: each individual check — one `curl`, one `docker inspect` — is too
small to be worth a brief, so it never crosses the delegation threshold.
Cumulatively they consumed the context that was supposed to be reserved for
judgment. The drift is gradual and locally rational at every step, which is why
a rule ("delegate the verification too, not just the work") is needed rather
than discretion.

### 4.4 A task was marked `relayed` after the `result` POST returned 400

The two calls were chained in one command. The result POST failed; the relayed
POST succeeded. Net effect: the user's question was **closed with `result: null`
and he would never have been told**. Compounding it, the malformed body produced
the server error `"result is required"`, which reads like a forgotten field
rather than a JSON parse failure, sending the debugging in the wrong direction.

Forensics confirm this class was not a one-off: **4 tasks in the log have
`relayedAt` before `resultTs`.**

### 4.5 A diagnostic probe permanently overwrote a real answer — three times

The queue accepts exactly one result per task. Posting `test` to a live task to
debug a 400 made `test` the answer, and the real correction was then refused
with 409. The log shows **three** user questions closed this way, all marked
relayed. Two were in `main`; one was in the `Test` conversation.

This is not an agent being careless once. It is a protocol that offers no
distinction between a probe and an answer, on an endpoint that is
write-once-destructive, with no undo.

### 4.6 Verification too shallow, twice, and wrong out loud

Both failures were the same shape: **HTTP status code checked, response body not
read.**

1. Concluded mindmeld held no phone notifications, from a query of the valid
   `dataClass` values. `dataClass` is a classification axis; `source` is a
   separate field. The data was there. Worse: the vocabulary is open and only
   one class is visible to the default search, a gotcha that was *already in the
   coordinator's own memory* and was not applied.
2. Concluded mindmeld served no OpenAPI spec, from a 404. The 404 body literally
   said `"OpenAPI spec not bundled in this deployment"` — which is a different
   and more useful fact.

The first was spoken aloud through a speaker while the user was mid-task on a
timer. He corrected both. A related pattern from the same night: the relay
outage was misdiagnosed twice in a row before anyone took a measurement.

**Rule that falls out: two confident wrong diagnoses in a row means stop
hypothesising and measure.**

### 4.7 Three safety nets that looked like protection and were not

All three in different repos, all three discovered the same night:

- **A stub UI suite passing 173 assertions** while the user's chat input and
  menu were off the bottom of his phone. It asserted elements *existed*. The
  real geometry suite would have caught it.
- **The real geometry suite requires a manual playwright install** that a
  deliberately zero-dependency project does not carry — so it silently stops
  being run. It also drives only one viewport, so every other phone width is
  uncovered, and the newest page had zero assertions at all.
- **A personal-data guard that passed on a live leak.** Its term list is five
  hashes and its rules inspect path *shapes*. It cannot see content it was not
  told about, which is precisely the case that matters.

The shared mechanism: **each was measured by whether it passed, never by whether
it could fail.** A check nobody has watched fail on purpose is not a check.

### 4.8 A chain-of-custody failure caused by a brief

A brief instructed an agent to leave its work committed. It was written before
anyone had established (a) that the target repo was public and (b) that another
agent had put the user's private data into the working tree. The brief was not
wrong when written; it was wrong when executed, and nothing in the system
re-evaluates a brief against facts discovered after it is issued.

---

## 5. Structural findings about the relay protocol

These are properties of the relay, independent of who was driving it. They are
the section most worth acting on.

**Agents cannot initiate a message; they can only answer one.** `createTask`
sets `role` server-side and ignores the client (`server.js:1566`), and there is
no delete route. An unprompted agent update therefore lands in the thread
*looking like the human said it*, sits `pending`, and trips the agent's own
watcher. The only way to speak unprompted is to post a task and immediately
answer it, accepting that both halves appear in his thread. **36 messages (12%
of the night) are this workaround** — and 19 of them are agent-to-agent
coordination traffic with no reason to be in a human's thread at all.

**One result per task, enforced, with no undo.** A probe sent to a live task
permanently destroys the real answer. Happened three times.

**`relayed` is not gated on `result`.** The two are independent writes, so a
task can be marked delivered while carrying no answer. Happened four times.

**Conversation ownership is convention, not code.** Nothing in the server binds
an agent to a conversation. An unfiltered poll does not double-answer — it
*silently steals*, because the one-result rule means the first writer wins and
the rightful owner never learns the message existed. The only reason this did
not cost more is that the rule was written down at 01:14 and obeyed.

**Liveness: "last acted" is trustworthy, "last seen" is not.** A heartbeat
emitted from a background poll loop proves the loop is ticking, not that anyone
is home. An agent slept eight minutes while its status read "alive 0s ago". The
`/status` headline compounded this by attributing a claimed message to whichever
agent the watch block selected rather than to the agent that actually claimed
it — so it named the wrong agent as stuck while nothing was stuck at all. **A
status page that cries wolf gets ignored exactly once too often.**

**A claim is not a lease.** `claimedAt` with no `resultTs` and no expiry is how
a message sat for 3h14m: claimed 25 seconds after arrival, then orphaned when
the session died. Nothing reclaims it. It was found by accident.

---

## 6. Proposed changes

Ranked within each group by (damage prevented) × (cheapness).

### A. Things the relay can fix in code

**A1. Gate `relayed` on `result` server-side.** Reject any attempt to mark a
task relayed while `result IS NULL`. Removes failure 4.4 entirely and makes the
client-side ordering discipline unnecessary. One conditional. *Addresses: 4.4,
4 logged occurrences.*

**A2. Claim leases with expiry.** A claim expires after N minutes without a
result and the task returns to `pending`, with the reclaim recorded. Directly
addresses the 194-minute orphan and the 32-minute rot; both were caused by a
claim that outlived the claimer. *Addresses: 4.1, 5 ("a claim is not a lease").*

**A3. A real agent-initiated message route.** `POST /messages` with
`role: agent`, so an agent can speak without the message appearing as the
human's own words and without tripping its own watcher. Removes the
post-then-self-answer workaround (17 occurrences) and halves the thread noise.
*Addresses: 5 ("agents cannot initiate").*

**A4. A separate agent-to-agent channel.** 19 of the night's messages were
coordination traffic routed through the human's phone thread because there is
nowhere else to put it. Either a `visibility: internal` flag on tasks or a
distinct route. Cheap, and it makes the human thread readable again.
*Addresses: 5, 12% thread pollution.*

**A5. Server-side conversation ownership.** A conversation records its owning
agent; `POST /tasks/:id/claim` from a non-owner returns 409 unless it passes an
explicit `takeover: true`, which is logged. Converts a silent theft into a loud
one. Note the legitimate takeover path must remain — the router *did* need to
answer in a stalled coordinator's tab, and did it openly. *Addresses: 5
("ownership is convention").*

**A6. An external wake channel.** The one thing no agent can do for itself. A
`POST /wake` that reaches a session from outside — anything durable and outside
the session, in the shape of the already-containerised watchdog. Until this
exists, every liveness guarantee in the system depends on some other live
session choosing to poke, which is how a coordinator sat on two unanswered
messages. Hardest item here and the highest ceiling. *Addresses: 4.1.*

**A7. Distinguish a probe from an answer.** Either a `POST /tasks/:id/validate`
that accepts and discards a body, or make the first `result` write revocable
within ~60 seconds. Three real answers were destroyed by debugging traffic.
*Addresses: 4.5.*

**A8. Report backlog, not just latency.** `/status` should surface *oldest
unanswered age* and *backlog depth per conversation* — the metrics that describe
the human's experience. 54% of his messages landed on a non-empty queue and
nothing said so. Also fix the two known `/status` bugs: attribute a claimed task
to its actual claimer, and exclude shell watchers from stuck-attribution.
*Addresses: §2, 5 ("liveness").*

**A9. Route completion notifications to the commissioner, not the spawner.**
Carry an explicit "report to" identity through delegation. *Addresses: 4.2.*

### B. Things that are process, not code

**B1. Delegate the verification too, not just the work.** The rule is already in
`COORDINATOR.md` and it is the one most likely to erode, because each individual
check is too small to hand off. The concrete form: an **independent checker
agent** that never touches the keyboard of the coordinator. *Addresses: 4.3.*

**B2. Read the body, not the status code.** Two wrong conclusions were spoken to
the user because a 404 and a 200 were treated as the whole answer. One of them
was contradicted by the response body verbatim. *Addresses: 4.6.*

**B3. Two wrong diagnoses in a row → stop hypothesising, take a measurement.**
Observed as a repeated pattern, not a single event. *Addresses: 4.6.*

**B4. Front-load the deciding constraint into every brief.** Not the goal — the
fact that eliminates the wrong designs. This was the clearest quality
differentiator of the night. *Addresses: §3.*

**B5. Assign one file per agent, explicitly, including against yourself.** The
only near-collision was one nobody had declared ownership for. *Addresses: §3.*

**B6. Always branch into a worktree.** The property, not the convention, that
made parallel agents safe. Note that in this repo the checkout *is* the
deployment — the server watches its own source — so editing in place ships
unreviewed work to the user's live page. *Addresses: §3, 4.8.*

**B7. Re-validate a brief against facts discovered after it was issued.**
Specifically before any instruction to commit or publish: confirm repo
visibility and working-tree contents *at execution time*, not at brief-writing
time. *Addresses: 4.8.*

**B8. Test the tests by making them fail on purpose.** Before trusting any
guard, feed it the thing it is supposed to catch. All three safety nets in 4.7
would have been exposed in minutes. Corollary: a test requiring a manual install
step will stop being run — either vendor the dependency or stop counting it as
coverage. *Addresses: 4.7.*

**B9. One agent, one conversation, watcher armed before anything else.** The
staffing arrangement with the best measured latency, by a factor of 2 to 6.
*Addresses: §2.*

**B10. Invite disagreement explicitly in every brief.** Five premises in
coordinator briefs were overturned by agents, all in briefs that asked for it.
*Addresses: §3.*

---

## 7. What could not be measured

Stated so nobody mistakes absence of evidence for evidence of absence.

- **Time-to-read.** The queue records when an answer was posted, not when he saw
  it. Real felt latency is longer than every number above.
- **Messages never sent.** If the backlog discouraged him from asking something,
  it leaves no trace.
- **Pokes.** The three pokes to the stalled coordinator went over the agent
  channel, not the relay, so they are absent from the log. Any inter-agent
  activity outside `POST /tasks` is invisible to this analysis.
- **Answer quality.** Everything above measures latency and protocol integrity.
  Nothing here measures whether an answer was *correct* — and the two false
  agent reports are a reminder that the two are independent.
