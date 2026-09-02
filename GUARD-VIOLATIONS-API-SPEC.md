# Guard violations - a first-class endpoint, so the fence can be audited

**Status: SPECIFIED, NOT APPLIED.** Written 2026-09-02 by `auto-relay-7qm5` in relay tab
`Relay` (`mtjhp9tt-897qm5`), in response to:

> *"Upgrade relay to have an explicit endpoint for posting and getting guard violations
> for me to audit and potentially modify the system if I notice a pattern of stuff to
> allow."*

Same wall as the other two specs: an auto-seated coordinator cannot write `.js`, cannot
run `node`, and cannot delegate. Hand this to an interactive session rooted at
`/home/hypnodroid/Projects/relay-queue`.

---

## Why this is worth building, in one paragraph of evidence

The guard's current reporting mechanism is: *"REPORT THIS VIOLATION NOW... into relay
conversation `main`"* via `POST /messages`. **That turns a log line into a task a human
has to close.** It is not hypothetical - while writing this spec, task
`mtjiyuyu-ykq50k` was sitting **pending** in this very tab, and its entire content was
another coordinator's guard-violation report:

```
GUARD BLOCKED: foreach() { :; } curl ... /tasks/mtji1sxk-a0umji/claim ...
  - rule not-allowlisted. I tried to act instead of delegating.
```

A message is the wrong shape for this. It buzzes a phone, it counts as pending work, it
is unaggregatable, and the one thing you actually want from it - *"which rule fires most,
and on what"* - requires reading the whole tab by eye.

**Three more were generated in a single 20-minute coordinator turn**, all from shell
syntax rather than intent:

| command | rule | was the intent actually forbidden? |
|---|---|---|
| `for t in <5 ids>; do curl .../claim; done` | `not-allowlisted` | **No.** 5 permitted relay POSTs |
| `curl .../progress ...; sed -n '1,120p' spec.md` | `sed` | **No.** A permitted POST plus a file read |
| `ls -la <paths> 2>&1 \| head -20` | `write-outside-temp` | **No.** The `2>&1` parser bug |

That third one is `GUARD-LOOSENING-SPEC.md` section 1, reproduced live for the second
time. **That is the pattern the human asked to be able to notice** - and today it is only
visible because one coordinator happened to narrate it. Make it a number.

---

## 1. The route

### `POST /guard-violations`

Body:

| field | req | notes |
|---|---|---|
| `rule` | yes | the guard's rule name (`sed`, `not-allowlisted`, `write-outside-temp`, ...) |
| `tool` | yes | `Bash`, `Write`, `Edit`, ... |
| `agent` | no | seat name. **`agent`, matching `/conversations` and `/activity`** - never `by`, which is the task-queue field. Getting this wrong is the single most-documented trap in this API |
| `conversationId` | no | alias `conversation`. Absent for a session with no tab |
| `command` | no | the offending input, **truncated to 400 chars and redacted** (below) |
| `cwd` | no | which checkout - the D:/WSL split makes this load-bearing |
| `sessionId` | no | groups a burst from one session |
| `decision` | no | `"deny"` (default) or `"allow"`. See *Log allows too* |
| `hookEvent` | no | `PreToolUse` / `PostToolUse` |

Returns `201` with the stored record plus `{ "seenBefore": <int> }` - how many times this
`rule`+`shape` pair has already been recorded. A coordinator can then say "the 4th time
today" instead of reporting each one as if it were novel.

**Never 4xx on a malformed violation report.** A guard that crashes or blocks because its
telemetry sink was picky is strictly worse than no telemetry. Missing `rule` -> store as
`"unknown"`. The one exception is the existing global UTF-8 refusal, which is enforced
before this handler.

### `GET /guard-violations`

Filters: `since` (ISO or ms), `until`, `rule`, `agent`, `conversation`, `tool`,
`decision`, `limit` (default 100, cap 1000), `order` (`desc` default).

Response: `{ count, total, truncated, violations: [...] }` - **match the `/messages`
contract exactly**, including `total` vs `count` and `truncated`, because that
distinction is already documented as a trap and a second convention would be a new one.

### `GET /guard-violations/summary` - the actual feature

This is what "notice a pattern of stuff to allow" means. `?window=24h` (default).

```json
{
  "window": "24h",
  "total": 37,
  "byRule":  [{ "rule": "not-allowlisted", "n": 19, "agents": 6, "lastAt": "..." }],
  "byShape": [{ "rule": "sed", "shape": "sed -n <args>", "n": 11,
                "examples": ["sed -n '1,120p' HOOKS-LIVENESS-SPEC.md"] }],
  "byAgent": [{ "agent": "auto-relay-7qm5", "n": 3 }],
  "topCandidates": [ ... ]
}
```

- **`shape`** is the command normalized: first word, plus flags with their values
  replaced by `<v>`, plus `<args>` for positionals. `sed -n '1,120p' a.md` and
  `sed -n '1,40p' b.md` collapse to one shape. **The shape is the unit of a loosening
  decision** - you allow a shape, not an incident.
- **`topCandidates`** ranks shapes by `n` and flags any whose first word is already in
  `INERT`-adjacent territory (read-only, no redirect, no substitution). It is a
  suggestion list, explicitly **not** an auto-apply: label it
  `"advisory - never applied automatically"` in the payload itself, so no future agent
  reads it as an instruction.

### `DELETE /guard-violations?before=<ts>`

Prune only. **No delete-by-id** - an audit log you can selectively edit is not one.

---

## 2. Storage - durable, unlike activity

Append to `data/guard-violations.jsonl`, one JSON object per line, alongside
`events.jsonl`. **Do not** put these in the activity ring: `ACTIVITY_CAP` is 200 per
conversation and `tool` rows are deliberately ephemeral, which is right for them and
wrong here. The entire request is *"audit over time and notice a pattern"* - a signal
that evicts itself in a busy minute cannot answer it.

- Keep an in-memory index for `summary` (rule -> shape -> count + last ts), rebuilt on
  boot by streaming the file. Cap the file at ~50k lines with a size-triggered prune of
  the oldest, logged when it happens.
- **These records must not enter the conversation thread.** No `appendEvent`, no
  `role:agent` entry, no push. A violation is telemetry; the whole point is that it stops
  buzzing his phone.

## 3. Redaction

**Reuse the redactor from `HOOKS-LIVENESS-SPEC.md` section 1 - one function, both callers.**
Guard violations quote raw command lines, which is exactly where a token appears, and a
conversation can be published (`POST /conversations/:id/share`). Two divergent redactors
is how one of them ends up weaker.

Strip: `sk-`/`ghp_`/`github_pat_`/`xox[baprs]-`/`AKIA`/`eyJ...` runs, `Authorization`
values, `-d`/`--data-binary` payloads, and anything after `?` in a URL.

## 4. The guard change - the point of all this

In `.claude/hooks/coordinator-guard.js`, on every deny:

1. **POST the violation to this endpoint** (fire-and-forget, `socket.unref()`, never
   blocking, never affecting the decision, wrapped in try/catch, exit path unchanged).
   Reuse `RELAY_CONVERSATION_ID` from `HOOKS-LIVENESS-SPEC.md` section 3 for the tab.
2. **Change the denial text.** Today it orders the coordinator to `POST /messages` to
   `main`. Replace step 3 with: *"This violation was logged automatically to
   `/guard-violations`. Do not post it as a message."* That deletes the class of pending
   task shown above.
3. Keep steps 1 and 2 (delegate; else hand to the user) **unchanged**. This spec changes
   only how a denial is *recorded*, never what is denied.

**Guard the recursion:** the reporting POST must be exempt from the guard's own analysis,
or a denied `curl` produces a report which produces a denial. The guard already allows
`127.0.0.1:3901`, but assert it in the selftest rather than assuming.

## 5. Log allows too, behind a flag

`RELAY_GUARD_LOG_ALLOWS=1` records `decision:"allow"` rows as well. Off by default -
it is high volume - but a loosening decision is much safer when you can see the
denominator: *"`sed` was denied 11 times and allowed 0"* is a different fact from
*"`sed` was denied 11 times out of 900 calls."*

## 6. UI (`public/index.html`)

A **Guard** view, not a per-tab panel - violations are cross-cutting and the point is
aggregate.

- Default: `byShape` from `/summary`, sorted by count, each row expandable to recent
  examples with agent, tab and cwd.
- A **rule filter** and a 24h/7d/all toggle.
- Each row shows *which spec already covers it*, if any: a shape whose rule is `sed` or
  whose command contains `2>&1` links to `GUARD-LOOSENING-SPEC.md`. **A pattern you have
  already decided to fix should not read as a new discovery** - that is what happened
  with `2>&1` twice.
- **No "allow this" button.** Loosening is a code change in the guard with a selftest;
  a one-click bypass of a default-deny fence is a different and much worse feature.

## 7. Tests

`tools/guard-violations-selftest.js` (read `tools/seat-release-selftest.js` first; match
its style and exit-code convention):

- POST with only `rule`+`tool` -> 201. POST with `{}` -> **201**, rule `"unknown"`, never 4xx.
- `seenBefore` increments across identical shapes and stays 0 for a novel one.
- Shape normalization: `sed -n '1,10p' a.md` and `sed -n '9,99p' b.md` -> one shape, n=2.
- Redaction: a command containing `sk-` + 30 chars is absent from both the stored line
  and every response body.
- A posted violation creates **no** thread entry and **no** activity row in any tab.
- `GET` honours `since`/`rule`/`limit`, and reports `total` > `count` with `truncated:true`.
- Guard integration: a denied command produces exactly one row, and the guard's decision
  is byte-identical with the endpoint up, down, and returning 500.
- Restart: rows survive a reload, and `summary` counts match after rebuilding from disk.

Then `node .claude/skills/relay-coordinator/validate-routing.js` from the repo root.

## 8. Docs

- Add a row to the routing table in `.claude/skills/relay-coordinator/SKILL.md` pointing
  at a new `references/guard-violations.md`. The table is validated - **add the row and
  the file in the same edit** or the validator fails.
- Amend the core rule that tells a blocked coordinator to post to `main`, wherever it
  appears, so the manual and the guard's own text agree.

## 9. Constraints for whoever applies this

Work only in `/home/hypnodroid/Projects/relay-queue`. Do not commit or push without being
asked. Do not restart the server by hand - it restarts on source change, and your own SSE
streams will drop. Do not touch `node_modules` or docker. Leave the guard's `.bak-*`
files alone. **Do not weaken any existing deny while wiring this up**; if a rule looks
wrong, that is `GUARD-LOOSENING-SPEC.md`'s job, not this one.
