# Claude hooks -> relay activity feed, and hooks as a liveness signal

**Status: SPECIFIED, NOT APPLIED.** Written 2026-09-02 by `auto-relay-7qm5` in relay
tab `Relay` (`mtjhp9tt-897qm5`), in response to:

> *"I want to improve relay so that we have pre/post tool uses Claude hooks that
> update the relay ui for a given tab - I want nerdy details and signals that the
> coordinator and its subagents are still doing stuff. I want our liveness checks to
> use the hooks as a signal to see if work is still being done."*

**Why this is a document and not a commit:** an auto-seated coordinator cannot write
`.js`, cannot run `node`, and cannot delegate (the Agent dispatch is refused by the
auto-mode classifier). Same wall documented in `GUARD-LOOSENING-SPEC.md`. Hand this
file to an interactive session rooted at this repo.

---

## The good news: most of the plumbing already exists

`POST /conversations/:id/activity` already accepts `kind:"tool"` with `agent`,
`subagent`, `tool` and `text` (server.js ~7005-7090). The UI already has a per-tab
activity panel (`#actview`, `public/index.html` ~3861-4050) and a collapsed badge on
the conversation list (`activityNode`, ~3402). Nothing reports into it automatically -
it depends on a coordinator remembering to narrate itself, which is exactly the thing
agents stop doing when they get busy.

**The hook makes it involuntary.** That is the entire value: the harness emits the
row, not the agent's good intentions.

Three things are actually missing:

1. a hook script that posts the rows,
2. the `conversationId` reaching that script,
3. the liveness code being allowed to read the rows - today it is explicitly forbidden
   to (server.js:314).

---

## 1. `.claude/hooks/relay-activity.js` - the hook

Registered on **both** `PreToolUse` and `PostToolUse`, matcher `*`.

### Hard rules, in priority order

- **It must never block a tool call.** Exit 0 always. Emit **no** `hookSpecificOutput`
  and **no** `permissionDecision` - only the guard is allowed to decide. Wrap the whole
  body in try/catch and exit 0 from the catch.
- **It must never add perceptible latency.** Every tool call in every session pays this.
  Budget: **`RELAY_HOOK_TIMEOUT_MS` = 15000 (15 s)** socket timeout on the POST,
  `timeout: 20` in settings so the harness never kills the hook before its own timeout
  fires, and failure is silent success. If relay is down, sessions must not notice.

  **15 s is a ceiling, not a cost, and that is only true if the POST is detached.**
  Set by the human on 2026-09-02 ("250ms is too short of a time period for Claude").
  A 15 s *blocking* hook on every tool call would be ruinous - so the hook must
  **write and stop waiting**: issue the request, `socket.unref()`, and exit 0 without
  waiting for the response body. The 15 s then bounds a background write to a
  possibly-restarting server (relay restarts itself on every source change, which is
  exactly when a short timeout drops rows), and the tool call is never held. If the
  implementation cannot detach, the number to change is this one - not the rule above it.
- **It must never be the reason a secret leaves the process.** See *Redaction* below.

### Input contract (already proven by the guard)

stdin is one JSON object. The guard reads `tool_name`, `tool_input`, `agent_id`
(`.claude/hooks/coordinator-guard.js:517-552`) - the same fields are what this hook
needs, plus `hook_event_name`, `session_id`, and `tool_response` on the Post event.

| field | use |
|---|---|
| `hook_event_name` | `PreToolUse` -> `phase:"start"`, `PostToolUse` -> `phase:"end"` |
| `tool_name` | the `tool` field |
| `tool_input` | the nerdy detail - see *What to put in `text`* |
| `tool_response` | `ok`, and a short outcome for the `end` row |
| `agent_id` | **present => this is a subagent.** Sets `subagent`, not `agent` |
| `session_id` | cache key for conversation-id resolution |

### Resolving the conversation id

In order, first hit wins:

1. **`RELAY_CONVERSATION_ID` env** - the primary path. See section 3 (autoseat).
2. **Sidecar cache** `${XDG_RUNTIME_DIR:-/tmp}/relay-hook/<session_id>.json`, written by
   this same hook the first time it sees the session's own relay traffic: on any
   `PreToolUse` for `Bash` whose command contains `127.0.0.1:3901` **and** a
   `"conversationId":"<id>"` or `/conversations/<id>`, record the id. A coordinator's
   very first act is its ack POST, so this self-arms within one tool call and covers
   hand-started interactive sessions that autoseat never touched.
3. **Give up silently.** No id, no POST, exit 0. A session with no relay tab is a
   normal session and must behave like one.

Cache files are keyed by `session_id` and are disposable; prune any older than 24h on
write. **Do not** reuse `/tmp` as a channel between two different tools - that mistake
is already on the record in the coordinator manual. This is one process writing and
reading its own file, which is a different thing.

### Attribution

- `agent` = `RELAY_AGENT` env, else the cached seat name, else `"unknown"`.
- `subagent` = a name when `agent_id` is set. Claude Code does not hand the hook the
  human-readable subagent name, so use `"sub:" + agent_id.slice(0,8)` and let the
  coordinator's own `kind:"spawned"` row supply the real name; the panel already keys
  its roster off `spawned`/`finished`. **Do not** invent a `spawned` row from the hook -
  that would manufacture roster entries the coordinator never claimed.

### What to put in `text` - the nerdy details

One line, <= 200 chars after redaction, tool-specific:

| tool | text |
|---|---|
| `Bash` | first 160 chars of `command`, newlines collapsed to `;` |
| `Read` | basename + `:offset-limit` if present |
| `Edit`/`Write` | basename + `(+N/-M lines)` on the `end` row |
| `Grep`/`Glob` | the pattern, plus `path` if not cwd |
| `Task`/`Agent` | the subagent type + first 100 chars of the prompt |
| `WebFetch` | the **host only**, never the full URL (query strings carry tokens) |
| MCP `mcp__x__y` | the server and tool name, and nothing from the arguments |
| anything else | the tool name alone |

On the `end` row add `ms` (wall time between the paired start and end, computed by the
hook from its own sidecar - the server must not guess) and `ok` from whether
`tool_response` reports an error.

### Redaction

Before sending, drop any run of >=20 chars matching
`/(sk-|ghp_|github_pat_|xox[baprs]-|AKIA|eyJ[A-Za-z0-9_-]{10,})[A-Za-z0-9_\-]+/` and any
`--data-binary`/`-d`/`Authorization` value, replacing with `[redacted]`. Also drop
anything after `?` in a URL. **Relay tabs can be published** (`POST
/conversations/:id/share` inlines a snapshot to a public URL), so treat every activity
row as potentially public text.

Confirm what `share.js` includes: if the share snapshot carries the activity feed, that
is a new class of content on a public page and should be decided deliberately, not
inherited.

---

## 2. Server changes

### 2a. Amend the comment at server.js:314-317 - do this first

It currently reads, as a load-bearing invariant:

> `NOTHING HERE FEEDS LIVENESS. A tool call is not proof of useful work: an agent
> sitting in a poll loop emits them forever while achieving nothing, which is precisely
> the lie a heartbeat tells.`

**That objection was overruled by the human on 2026-09-02: *"If it uses tools, then it
should be considered working."*** Do not delete the comment - replace it, and record
what it used to claim, so the next reader does not reinstate it by accident. The
replacement must say:

> A tool row counts as **work in progress**. It feeds `evidenceOfLifeMs()` (which stops
> a live agent being evicted from its chair) **and** `agentLiveness()`'s `working`
> verdict. This block previously forbade the second one, on the grounds that a
> poll-looping agent emits tool calls forever while achieving nothing - the same lie a
> heartbeat tells. That objection is real but was judged the lesser cost: the failure we
> actually keep seeing is the reverse one, a demonstrably-executing agent being reported
> as `stale` or `silent` and evicted. **A hook row is strictly stronger than a
> heartbeat** - a heartbeat is a timer and survives its own agent, whereas a hook row
> cannot exist unless the harness really executed a tool - and it is still weaker than a
> progress note, which is written by the agent from inside the work and says what the
> work *is*. Only `PostToolUse` (`phase:"end"`) counts, so an agent being refused over
> and over by the guard does not read as healthy.
>
> What a tool row still does **not** do: silence `stalePending()`. That function asks a
> different question - *is a message sitting unclaimed in a staffed tab* - and an agent
> busy on its own tools while a new message goes unclaimed is exactly the case it
> exists to catch.

If the comment is left as-is, the next reader trusts an invariant the code no longer
holds. That is worse than the feature is good.

### 2b. `tool` rows stay ephemeral, and gain fields

Keep `tool` out of `DURABLE_KINDS` (server.js:322) - the reasoning there is right, and
hooks raise the volume by an order of magnitude, which makes it more right.

`activityRoute` accepts, for `kind:"tool"` only:

- `phase`: `"start"` | `"end"` (default `"end"` if absent, so an older caller behaves as
  today)
- `ms`: non-negative integer, rejected if absent-with-`phase:"end"`? **No** - optional,
  because the hook cannot always pair.
- `detail`: already covered by `text`; do not add a second free-text field.

### 2c. Coalescing, so the ring stays readable

`ACTIVITY_CAP` is 200 per conversation. A Read-heavy minute would evict the whole
history. In `pushActivity`, when the incoming entry is `kind:"tool"`, `phase:"end"`,
and the newest entry in the feed is also a `tool` `end` with the **same** `tool`, same
`agent`/`subagent`, and `at` within `ACT_COALESCE_MS` (default 15000), then increment
`repeat` on that entry and update its `at` and `ms` total instead of appending.

The UI renders `repeat > 1` as `Read x14`. `toolCalls` must count repeats, not rows.

### 2d. The liveness signal

Add a per-conversation in-memory `lastToolAt` (a `Map`, alongside `HEARTBEATS`; **not**
a field on the conversation record - it must not enter `events.jsonl`).

- Set it **only** on `phase:"end"`. A `start` row proves a call was attempted; the guard
  denies calls at `PreToolUse`, so a denied command produces a `start` with no `end`. A
  coordinator being repeatedly refused by its own guard must **not** read as alive-and-
  working - that is a wedged agent, and it is a shape we have actually seen.
- Fold it into `evidenceOfLifeMs()` (server.js:3259) as one more term in the `signals`
  array. Both callers - `sweepVacantChairs` (45 min) and `seatWatchInfo` (2 min) - then
  pick it up with no further change, which is exactly what that function was extracted
  for.
- **Fresh tool activity satisfies `working` in `agentLiveness()` (server.js:1798-1845).**
  Decided by the human on 2026-09-02: *"If it uses tools, then it should be considered
  working."* Widen the existing term rather than adding a state:

  ```
  const toolingAgoSec = secSince(lastToolAt.get(c.id));
  const tooling = toolingAgoSec !== null && toolingAgoSec * 1000 <= TOOL_FRESH_MS;
  ...
  if (progressing || tooling) return { ...base, state: 'working' };
  ```

  `TOOL_FRESH_MS` = `Number(process.env.TOOL_FRESH_MS || PROGRESS_FRESH_MS)`.

  **There is no `busy` state.** An earlier draft of this spec proposed one, ranked below
  `working`, so that "running tools but reporting nothing" read as a warning. That was
  rejected. Do not reintroduce it, and do not add a softer variant of it - if the
  distinction turns out to matter, it is a new conversation, not a quiet re-hardening.

- **Keep the *reason* visible even though the verdict is the same.** `working` from a
  progress note and `working` from tool rows are equally green, but the roster should
  still say which one it saw (`why: 'progress'` | `'tools'` on the returned object) -
  that costs nothing and is what makes the choice above auditable later.

- **`stalePending()`, the nudge, and the deadman banner are unchanged.** They answer a
  different question: *is a message sitting unclaimed in a staffed tab.* An agent running
  tools while a new message goes unclaimed is precisely what that mechanism is for, so
  tool rows must not silence it. This is not a hedge against the decision above - the
  decision was about whether the **agent** is working, not about whether the **message**
  has been picked up.

### 2e. `activitySummary` (server.js:2010)

Add `lastToolAt`, `toolsPerMin` (over the last 5 min of the ring), and `running` -
the count of `start` rows with no matching `end` older than 60s, so the badge can say
`Bash running 41s`.

---

## 3. `tools/autoseat.js` - hand the hook its tab

The spawn at `tools/autoseat.js:503` passes no `env`, so the child inherits this
process's. Add:

```js
child = spawn(cfg.claude, args, {
  cwd: cfg.cwd,
  stdio: ['ignore', fd, fd],
  windowsHide: true,
  env: { ...process.env, RELAY_CONVERSATION_ID: conv.id, RELAY_AGENT: agentName },
});
```

using the same id and agent name already in scope for the dispatch. Subagents inherit
it, which is what makes their tool rows land in the right tab for free.

Cover it in `tools/autoseat-selftest.js`: assert both vars are present in the spawn
options and that the value matches the conversation being seated. A wrong id here posts
one tab's activity into another and would look like a UI bug for a long time.

---

## 4. `.claude/settings.json`

This change **does** require editing that file - which `GUARD-LOOSENING-SPEC.md`
tells you not to do. That prohibition is about **moving** the registration, because
`settings.json` is read only for the directory the session is rooted in. Adding an entry
in place is fine. Concretely:

- Keep the existing `PreToolUse` guard entry **byte-identical and first in the array.**
- Add `relay-activity.js` as a second `PreToolUse` entry and a new `PostToolUse` entry,
  matcher `*`, `timeout: 20` (must exceed the hook's own 15 s socket ceiling, or the
  harness kills the hook first and the ceiling never applies).
- Do not change the `command` path style of the guard entry (absolute node path) -
  match it.

After editing, verify the guard still fires by attempting a denied command; a silently
unregistered guard is the failure mode this repo warns about most.

---

## 5. UI (`public/index.html`)

The panel already exists; it needs the live edge.

- **Now-running line** at the top of `#actview`: `Bash - node tools/ui-selftest.js` with
  a ticking `41s`, driven by unmatched `start` rows. Clears on the `end` row.
- **Tool rows** render `tool`, `text`, `ms`, and `x<repeat>`; failures (`ok:false`) get
  the existing warning treatment rather than a new colour.
- **Per-subagent tool counts** in `subagentNode` - a subagent with 0 tool calls in 10
  minutes while still "running" is the ghost the panel already warns about, and now it
  can say so with evidence.
- **Conversation list badge** (`activityNode`): `12 tools/min` when live, and it must
  keep the existing honesty about snapshot age - a tool rate from a stale snapshot is
  exactly the live-sounding claim that code already refuses to make.
- **The roster says *why* a tab reads `working`.** Same green state either way, but
  `working - progress note 2m ago` and `working - 31 tools in the last 5m` are different
  facts and the panel already has room for both. No separate `busy` vocabulary; that
  state does not exist (section 2d).

---

## 6. Tests

`tools/activity-hooks-selftest.js` (read `tools/seat-release-selftest.js` first, match
its style and exit-code convention). It must cover:

- The hook spawned with synthetic stdin **emits nothing on stdout** and exits 0, for
  `PreToolUse` and `PostToolUse`, with and without `agent_id`.
- Relay unreachable -> still exits 0, and **returns in well under 15 s** (proving the
  POST is detached and the 15 s ceiling is never paid by the tool call).
- No `RELAY_CONVERSATION_ID` and no cache -> no POST at all.
- Sidecar arming: a `Bash` command containing `"conversationId":"abc-123"` makes the
  next call post to `abc-123`.
- Redaction: a command containing `sk-` + 30 chars never appears in the POST body.
- Coalescing: 20 identical `Read` ends within the window produce one row with
  `repeat: 20`.
- `phase:"start"` alone does **not** move `evidenceOfLifeMs`; `phase:"end"` does.
- A conversation with only tool rows and a waiting message reports `state:"working"`
  (with `why:"tools"`), and **`stalePending` still lists it** - those two must be
  asserted together in one test, because it is the pairing that is easy to break.
- Tool rows older than `TOOL_FRESH_MS` stop vouching: the same conversation reports
  `working` at `TOOL_FRESH_MS - 1s` and does not at `TOOL_FRESH_MS + 1s`.
- No `state:"busy"` is ever returned by `agentLiveness()`, for any input.

Then `node .claude/skills/relay-coordinator/validate-routing.js` from the repo root, and
`node tools/autoseat-selftest.js`.

---

## 7. Constraints for whoever applies this

Work only in this repo. Do not commit or push without being asked. Do not restart the
server by hand (it restarts itself on source change - expect your own SSE streams to
drop). Do not touch `node_modules` or docker. Leave the guard's `.bak-*` files alone.

## 8. The one judgement call - ANSWERED 2026-09-02, no longer open

**Question:** should an agent that is running tools but reporting no progress read as
`working`?

**Answer, from the human, verbatim:** *"If it uses tools, then it should be considered
working."*

Sections 2a, 2d, 5 and 6 above already reflect this. **Nothing here is left to decide -
implement it as written.**

The objection this overrules, recorded so it is not rediscovered as news: a poll-looping
agent emits tool calls forever while achieving nothing, so tool rows can make the
deadest tab on the page look like the healthiest. Two things blunt it, and both are
already in the spec: only `PostToolUse` counts (so an agent being denied by the guard in
a loop never registers), and `stalePending()` is untouched (so an unclaimed message is
still surfaced no matter how busy the tab looks). What remains of the risk was accepted
deliberately, because the failure actually observed in this system is the opposite one -
live agents reported dead and evicted mid-work.
