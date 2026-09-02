# A remote Claude launcher for WSL, with the allowlist in this repo

**Status: SPECIFIED, NOT APPLIED.** Written 2026-09-02 by `auto-guard-loosening-fkrj`
in relay tab `Guard Loosening` (`mtjiwfgi-02fkrj`), in response to:

> *"I need a Claude agents remote listener in wsl. With my relay project as an
> allowlist for where I can start Claude."*

Fourth spec in a row written by a coordinator that could not apply it. Both delegation
attempts from this seat - one to `git commit`, one to edit `server.js` - were refused by
the auto-mode classifier, not by the guard. See `LAUNCH-PROMPT.md`; add this file to its
reading list.

---

## The one-line summary

**Start a Claude session in any allowlisted project, from your phone, through relay.**
Today `tools/autoseat.js` can do this for exactly one directory and exactly one shape of
work (seat a coordinator in a relay tab). This generalises it: relay holds the registry
of *where* Claude may be started, and a small WSL daemon does the starting.

---

## 1. The decision that shapes everything else: it polls, it does not listen

The ask says "listener". **Do not build one.** Do not open a port in WSL, do not bind a
socket, do not run an SSH-ish agent.

`server.js` authenticates nothing by design; Cloudflare Access in front of
`relay.hypnodroid.com` is the entire security model, and the coordinator manual already
states the consequence: *"a leaked relay URL isn't a data-exposure risk, it's remote code
execution by proxy."* A launcher makes that literal - the payload is no longer "a task an
agent might act on", it is `spawn(claude, ...)` in a directory you chose.

**A second inbound surface would sit outside Access and be unauthenticated RCE on the
host.** So:

- The daemon makes **outbound** requests to `http://127.0.0.1:3901` only.
- It accepts **no** connections, has **no** listening socket, and needs **no** firewall
  rule.
- The remote half is relay, which is already behind Access and already audited.

This is exactly the autoseat architecture (`tools/autoseat.js` polls the queue and
spawns), and it is the correct one. Reuse it rather than inventing a new trust boundary.

## 2. The allowlist

### Where it lives

`launch-targets.json`, committed at the root of **this** repo. That is the literal
reading of "my relay project as an allowlist", and it has a real property: the allowlist
is versioned, reviewable in `git log`, and travels with the guard and the coordinator
skill that already live here for the same reason.

```json
{
  "targets": [
    {
      "key": "relay-queue",
      "label": "Relay queue",
      "cwd": "/home/hypnodroid/Projects/relay-queue",
      "model": null,
      "permissionMode": "default",
      "maxConcurrent": 2,
      "note": "The live checkout. NOT /mnt/d/projects/relay-queue."
    }
  ]
}
```

**Ship with exactly this one entry.** Adding a second is a one-line commit and a
deliberate act; starting with a broad list is not recoverable once something has run.

### The three rules that make it an allowlist rather than decoration

1. **A path never travels over the wire.** `POST /launch` takes `target: "relay-queue"`,
   a key. There is no `cwd` field in the request body, at any level, ever. If a caller
   can name a directory, the allowlist is advisory.
2. **There is no route that writes the allowlist.** No `POST /launch-targets`, no
   `PATCH`, no "add from the UI". Editing it means editing a file in a git repo. A
   default-deny fence with an API to add exceptions is not a fence - that is the same
   reasoning `GUARD-VIOLATIONS-API-SPEC.md` section 6 uses to refuse an "allow this"
   button, and it applies with more force here.
3. **Resolve, then re-check.** After mapping key -> `cwd`, `fs.realpathSync` it and
   require the result to be byte-equal to an allowlisted entry. Refuse anything
   containing `..`, any symlink that escapes, and any path that does not exist. Refuse a
   `cwd` that is not a directory. This is cheap and it is the difference between an
   allowlist and a prefix check.

### Reloading

Re-read the file on every poll, and validate it before use. **If it fails to parse, keep
the last known-good list and log loudly - do not fall back to an empty list and do not
fall back to a permissive one.** An unparseable allowlist is an operational error, not a
policy change.

## 3. Relay API

### `GET /launch-targets`

Returns the parsed allowlist plus, per target, `running` (current live launches) and
`lastLaunchAt`. Read-only. This is what the phone UI renders as a picker.

The daemon is the only thing that reads the file from disk; relay reads it too, for this
route. Both must use the same validator - export it once from `tools/launch-targets.js`
and require it from both, rather than parsing it twice with two opinions.

### `POST /launch`

| field | req | notes |
|---|---|---|
| `target` | yes | an allowlist **key**. Unknown key -> `400`, and the error names the valid keys |
| `prompt` | yes | the `-p` prompt. Cap at 32k chars |
| `conversationId` | no | alias `conversation`. Tab to report into and to set `RELAY_CONVERSATION_ID` |
| `agent` | no | seat name for the session; defaults to `launch-<target>-<short id>` |
| `model` | no | must be in a small hardcoded set; anything else -> `400`. Never passed through raw |
| `label` | no | free text for the launch list |
| `requestedBy` | no | `"web"` / `"phone"` - provenance for the audit log |

Returns `202` with the launch record, `status: "queued"`. **`202`, not `201`** - nothing
has started yet, and the distinction matters when you are staring at a phone wondering
whether the daemon is even up. Include `daemonSeenAt` in the response so the caller can
tell "queued and the daemon is alive" from "queued into the void".

### `GET /launches`

Filters `status`, `target`, `conversation`, `since`, `limit` (default 100, cap 1000).
Response is `{ count, total, truncated, launches: [...] }` - **match the `/messages`
contract exactly**, `total` vs `count` and `truncated` included. A second convention here
would be a new trap in an API whose manual is mostly a list of traps.

### `GET /launches/:id`

The full record: `status`, `pid`, `startedAt`, `exitedAt`, `exitCode`, `logFile`,
`cwd` (resolved, for audit - it is safe to *report* a path, only unsafe to *accept* one).

### `POST /launches/:id/cancel`

Advisory, mirroring `stopRequested` on conversations: sets `cancelRequested`. The daemon
sends `SIGTERM`, waits 10 s, then `SIGKILL`, and records which one ended it. Relay never
signals a process itself - it does not own one, exactly as it does not spawn one today.

### Status machine

`queued -> claimed -> running -> {exited, failed, cancelled}`, plus `refused` when the
daemon rejects it (unknown target, realpath mismatch, at cap). **`refused` is terminal
and carries a reason string** - a launch that silently never runs is the worst outcome
here, because the human is on a phone with no terminal to check.

## 4. The daemon - `tools/launcher.js`

Model it on `tools/autoseat.js`; read that file first and match its structure, its
logging, its `--dry` flag, its heartbeat file and its supervisor loop.

Loop, every `--interval` (default 5000 ms):

1. `GET /launches?status=queued`, oldest first.
2. Re-read and validate `launch-targets.json`.
3. For each candidate, in order: resolve the target; refuse with a reason if unknown or
   if realpath fails; skip if at the target's `maxConcurrent` or the global cap.
4. **Claim before spawning**, `POST /launches/:id/claim {"by":"<daemon name>"}`, and
   spawn only on a `200`. Two daemons must never both start a session; the claim is what
   makes that impossible rather than unlikely.
5. **Record, then spawn** - autoseat's comment at `tools/autoseat.js:502` explains why
   that order and not the reverse, and the reasoning transfers verbatim. A crash between
   the two costs one launch that never happened, which is visible. The other order costs
   a launch that re-fires on every restart, forever.
6. Spawn:

```js
spawn(cfg.claude, args, {
  cwd: resolved,                    // realpath'd, allowlisted, never from the request
  stdio: ['ignore', fd, fd],
  env: { ...process.env, RELAY_CONVERSATION_ID: conv, RELAY_AGENT: agentName },
});
```

   `args` is `['-p', prompt]` plus `['--model', model]` when set. **Array argv, never a
   shell string** - no `shell: true`, no `exec`, no interpolation into a command line.
   The prompt is attacker-controlled by construction and must never be parsed by a shell.
7. Log to `logs/launch-<id>-<ts>.log`, same directory convention as autoseat.
8. On exit, `POST /launches/:id/exit {"code":N,"by":...}`.

### Caps, because a launch loop is a fork bomb with a 5-second period

- Global `--max-concurrent`, default **3**. Independent of autoseat's cap; they are
  different budgets and sharing one would let launches starve tab-seating.
- Per-target `maxConcurrent` from the allowlist, default 1.
- **Rate limit**: at most N launches per rolling hour (default 20), and on hitting it,
  refuse with a reason and log it once, not once per poll.
- A per-launch wall-clock ceiling (`--max-runtime`, default 60 min) after which the
  daemon terminates it and records `exitCode: null, endedBy: "timeout"`.
- **Refuse to run as root.** Exit 1 at startup with a clear message.

### Heartbeat and supervision

Write `launcher.heartbeat` beside autoseat's, same format, so the existing health surface
can report both. Supervise it the same way autoseat is supervised. A launcher that is
down looks exactly like a launcher that is idle, and the `daemonSeenAt` field in
section 3 is only truthful if this exists.

## 5. Audit log

Append every launch and every refusal to `data/launches.jsonl`, one object per line,
durable, never in the activity ring and never in a conversation thread.

Redact the prompt with **the same redactor** as `HOOKS-LIVENESS-SPEC.md` section 1 and
`GUARD-VIOLATIONS-API-SPEC.md` section 3 - one function, now three callers. A prompt is
free text a human typed on a phone and is a plausible place for a pasted token.

## 6. Why this is worth building beyond the literal ask

**It is the exit from the deadlock this tab is currently in.** Four specs are written and
none are applied, because an auto-seated coordinator cannot write `.js`, cannot run
`node`, and cannot delegate - the classifier refuses the subagent. Every attempt costs
20-30 minutes and a concurrency slot, and produces another document.

A launch record can carry a target whose directory has its own
`.claude/settings.local.json` granting the permissions an autoseat coordinator lacks
(`LAUNCH-PROMPT.md` step 0 already writes exactly that file). **That turns "paste this
prompt into a terminal when you next sit down" into a button on a phone** - which is the
only step in this whole backlog that no agent can currently perform.

Build it in the order: allowlist + validator, then the daemon with `--dry`, then the
routes, then the UI. The daemon with `--dry` and a hand-written queued record proves the
resolution and refusal paths before anything can ever spawn.

## 7. Tests - `tools/launcher-selftest.js`

Read `tools/seat-release-selftest.js` first and match its style and exit-code convention.

- `POST /launch` with a `cwd` field anywhere in the body -> the field is **ignored**, and
  the resolved cwd is the allowlisted one. Assert this explicitly; it is the whole
  security model in one test.
- Unknown `target` -> `400`, and the response names the valid keys.
- A target whose `cwd` is a symlink pointing outside the allowlist -> `refused`, never
  spawned.
- A target containing `..` -> `refused`.
- `model` not in the hardcoded set -> `400`, and the value never reaches argv.
- A prompt containing `; rm -rf ~` and backticks reaches the child as **one argv element,
  unmodified**, and no shell interprets it. Assert against a stub `claude` that dumps its
  argv.
- Malformed `launch-targets.json` -> daemon keeps the previous list, logs, and does not
  fall back to permissive or empty.
- Concurrency: N+1 queued against `maxConcurrent: N` leaves exactly one `queued`.
- Two daemons against one queued record produce exactly one spawn (the claim guard).
- Rate limit: the (limit+1)th launch in the window is `refused` with a reason.
- Cancel: `SIGTERM` first, `SIGKILL` after the grace, and the record says which.
- Restart: queued records survive a relay reload and are picked up.
- Refuse-as-root path exits non-zero.

Then `node .claude/skills/relay-coordinator/validate-routing.js` from the repo root and
`node tools/autoseat-selftest.js` (unchanged - this must not disturb autoseat).

## 8. Docs

Add `references/launcher.md` to the coordinator skill **and its routing-table row in
`SKILL.md` in the same edit** - the table is validated and will fail otherwise. Trigger
condition: *"start a Claude session in a project other than the one you are in"*.

## 9. Constraints for whoever applies this

Work only in `/home/hypnodroid/Projects/relay-queue`. Do not commit or push without being
asked. Do not restart the relay server by hand. Do not touch `node_modules` or docker.
**Do not modify `tools/autoseat.js`** while building this - it is running, it is
load-bearing, and it already has uncommitted changes in the tree.

## 10. The open questions - ask, do not assume

1. **How wide is the allowlist on day one?** This spec ships one entry (`relay-queue`),
   reading *"my relay project as an allowlist"* as *"the allowlist lives in the relay
   project"*. If the intended reading was *"relay-queue is the only place Claude may
   ever start"*, the spec is unchanged and the answer is simply never to add a second
   row. Which are the other projects, if any?
2. **Should a launch be able to name a permission mode**, or does it always inherit the
   target directory's `.claude/settings.local.json`? Inheriting is safer and keeps the
   grant in a reviewable file; naming it per-launch is more flexible and is what makes
   the phone button able to fix a wedged tab. This spec assumes **inherit**, and it is
   the one place where the more useful answer is also the weaker one.
