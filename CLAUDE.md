# relay-queue

Message queue between the human and his agents. `server.js` on `http://127.0.0.1:3901`.

Coordinator protocol: read **`COORDINATOR.md`** (a stub pointing at the
`relay-coordinator` skill in `.claude/skills/`). Read it before touching relay.

---

## THE GUARD — read this before you try to run anything

`.claude/hooks/coordinator-guard.js` is a **PreToolUse hook, DEFAULT DENY**,
registered by `.claude/settings.json` for this directory. It fires on
`Bash | PowerShell | Write | Edit | NotebookEdit` for the **session main
thread** only.

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

Denials append to `.claude/coordinator-violations.log`.

### Do not break the registration

Claude Code loads project settings **only for the directory the session is
rooted in** - `CLAUDE.md` walks up the tree, `settings.json` does **not**.
`tools/autoseat.js` spawns every coordinator with `cwd` set to this repo root,
which is what makes this `.claude/` load at all.

**Change that cwd and the guard silently stops firing** - no error, no log line,
and default-deny becomes default-allow. The spawn cwd, the skill and the guard
registration move together or not at all.
