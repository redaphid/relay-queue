# relay-queue

Message queue between the human and his agents. `server.js` on `http://127.0.0.1:3901`.

> **Active handoff:** the folder-scopes work in progress is described in
> HANDOFF.md, imported below. When its objective is complete (feature merged
> and the post-deploy migration done), delete HANDOFF.md and remove this note
> and the `@HANDOFF.md` line.
> The latest handoff is always written to the root HANDOFF.md; older ones go in handoffs/.

@HANDOFF.md

Coordinator protocol: read **`COORDINATOR.md`** (a stub pointing at the
`relay-coordinator` skill in `.claude/skills/`). Read it before touching relay.

---

## THE GUARD — read this before you try to run anything

`src/claude-config/hooks/coordinator-guard.js` is a **PreToolUse hook, DEFAULT
DENY**, registered by `src/claude-config/settings.json`, which
`tools/autoseat.js` injects into **every seat it spawns** with
`--settings=<repo>/src/claude-config/settings.json`. It fires on
`Bash | PowerShell | Write | Edit | NotebookEdit` for the **session main
thread** only.

**Coordinator mode = a session started by relay.** This repo's own
`.claude/settings.json` holds permissions only and registers **no** hooks, so a
session you start here by hand is **not guarded** - by the owner's choice
(2026-09-19). If you are a relay seat, you are guarded wherever you stand.

### What it allows

| | |
|---|---|
| **Markdown writes** | `Write`/`Edit`/`MultiEdit` on `.md` / `.markdown`. Any other path: denied. |
| **Relay traffic** | `curl`/`wget` where **every** URL is `127.0.0.1:3901` (also `localhost`, `[::1]`), plus staging its JSON body in a temp path. |
| **Inert inspection** | `cat ls grep head tail wc find stat ps jq diff` and friends - the full list is `INERT` in the guard. |
| **Read-only `sed` `awk` `tee` `git`** | Vetted per call. `sed -i`, `awk` with `system()`, `tee` outside temp, and any `git` that commits / moves a ref / talks to a remote are all denied. |
| **Everything else** | **Denied.** Not "asked" - denied. |

### What it blocks, and why

- **Interpreters and package managers** - `python3`, `node`, `perl`, `ruby`,
  `npm`, `npx`, `pnpm`, `bun`, `go`, `cargo`, `make`. One line of any of them is
  arbitrary code, so allowing one is allowing all of them.
  **`python3` was proposed and REFUSED by the owner on 2026-09-02.** Do not
  re-propose it. Its absence from the *old* blocklist is the specific hole that
  fell through to a harness permission prompt and **froze the machine for hours
  on 2026-08-17** - the incident this guard was rewritten to prevent.
- **Anything that mutates the machine** - `rm mv cp mkdir chmod ln touch dd`,
  `docker`, `systemctl`, `kill`/`pkill`, `ssh`, `gh`, `sudo`.
- **Anything that blocks or never returns** - `sleep`, `watch`, `top`, `less`,
  `man`, `vim`. A hung coordinator holds an autoseat slot forever and starves
  every other tab. This is why `sleep` is denied despite doing nothing at all.
- **Anything that re-enters a shell** - `bash sh zsh pwsh eval env nohup exec`,
  and `git -c` (it can inject an executable into git). Shell loops (`for`,
  `while`) are denied for the same reason: not on the allowlist, so not run.

### Why it exists

**The coordinator routes work; it does not perform it.** The fence is against
drifting from *routing* into *doing*, and against parking the session on
something slow. It is not an adversarial sandbox - the coordinator is trusted.
The bar is:

> **read-only and fast = allow. mutating, long-running or interactive = deny.**

### The way through it

**Delegate.** Hook input carries `agent_id` on subagent calls and not on the
main thread, so **subagents are exempt and are allowed through before any other
logic runs**. Spawn one with the `Agent` tool and hand it the exact command.
If it genuinely cannot be delegated, hand the command to the human.

Do not reword a denied command, and do not reach for a different tool that does
the same thing.

Denials append to `src/claude-config/coordinator-violations.log` (resolved from
the guard's own location, never the seat's cwd).

### Do not break the registration

A seat's cwd is **its conversation's folder**: `~/<conversation.path>` (`/` is
home itself), or - when that folder is inside a git repo - the tab's own
worktree (below). So nothing about the guard or the skill may depend on cwd any
more, and nothing does. `tools/autoseat.js` passes, on every spawn, both derived
from its own location:

- `--settings=<repo>/src/claude-config/settings.json` - relay's settings and
  nothing else: the guard registration. It layers over the folder's own
  `.claude/settings.json`, which loads normally; relay never reads or manages a
  project's settings.
- `--add-dir=<repo>` - makes `.claude/skills/relay-coordinator` load.

Both in `--flag=value` form: both flags are variadic and the spaced form eats
following positionals.

autoseat **refuses to start** unless `src/claude-config/settings.json`
registers `coordinator-guard.js` (and the node and guard paths it names exist),
sets `"disableAllHooks": false`, and the skill's `SKILL.md` exists, and `tools/autoseat-selftest.js` asserts a
real spawn carries both. A seat without the guard fails silently - no error, no
log line, default-deny becomes default-allow - so it has to be impossible, not
merely unlikely. **The registration names the LIVE checkout's absolute guard
path**; move the guard and that file moves in the same commit. **Never drop
`"disableAllHooks": false` from it:** a folder whose own `.claude/settings.json`
or `settings.local.json` says `"disableAllHooks": true` silently switches off
the `--settings` guard too (verified 2026-09-19); relay's higher-precedence
`false` is what keeps it on.

`--cwd` is still accepted (the live supervisor passes it) and ignored with a
log line. `--home` sets the base the paths are relative to.

### Where a seat stands: folder, missing folder, worktree

- **Missing folder, or a path escaping home: nothing is spawned**, never a
  fallback cwd. autoseat posts one message into the tab (once per
  conversation+path, remembered in its state across restarts); the message waits
  and is seated once the folder exists or the tab moves.
- **Folder inside a git repo: the tab gets its own worktree**,
  `~/Worktrees/<repo>/<tab-slug>` on branch `<tab-slug>` (`<repo>` = basename of
  the MAIN working tree, so worktrees never nest; slug = kebab-case title). The
  seat runs at the folder's subpath inside it. New: branched from the fetched
  `origin/<default>`. Only the tab's **own** record pins a branch/worktree; any
  other branch, worktree or dir that merely shares the slug is never adopted
  (the tab takes `<slug>-2`, `-3`...), and nothing outside `~/Worktrees/<repo>/`
  is ever adopted. The pinned worktree gets `origin/<default>` **merged** in
  first - never rebase or reset; a dirty tree or a conflict is left exactly as it
  was (merge aborted) and still seated, with a note in the tab. Rename does not
  move it. Any failure seats the plain folder with a note and keeps the pin and
  the session. `worktree add`/`merge` run with the repo's hooks off and LFS
  smudge skipped. The folder the tab is filed under is never touched.
- **A tab moved to another folder** gets its coordinator retired when idle and a
  **fresh session** in the new place; a revive in the same folder resumes, even
  if its cwd changed because of a worktree fallback.
