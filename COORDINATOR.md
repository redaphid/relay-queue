# relay-queue — coordinator manual (moved)

**This manual is now a Claude Code skill. Read it before you do anything else.**

```
/home/hypnodroid/Projects/relay-queue/.claude/skills/relay-coordinator/SKILL.md
```

Open that file with your `Read` tool right now. `Read`, `Grep` and `Glob` are
unrestricted by the coordinator guard, so this always works. If your harness
surfaces skills, the skill is named **`relay-coordinator`** and you can invoke
it instead — but the path above is the guarantee, and it does not depend on
skill discovery working.

## Why this file is a stub and not the manual

The manual had grown to **53,641 bytes**, and every coordinator paid all of it
at boot whether or not it needed the deployment hazards, the credits economy or
the auto-seat internals. It was split on 2026-08-29 into:

- **`SKILL.md`** — the always-loaded core: **the rules you can violate.**
- **`references/*.md`** — read on demand: **the facts you would look up.** A
  routing table in `SKILL.md` gives the *trigger condition* for each one.

**No protocol was changed, added or removed by the split.** Every line was
relocated verbatim; only cross-references between sections were retargeted at
their new files.

## Why this stub must keep existing

`D:\projects\CLAUDE.md` tells every coordinator to read `COORDINATOR.md`.
Deleting or emptying this file means a coordinator boots with no protocol at
all, silently. Leave the pointer here — it is the route that does **not**
depend on skill discovery working.

## Where the protocol and the guard now live

Both live in this repository (as of **2026-09-19**, split project vs relay config):

- `.claude/skills/relay-coordinator/` — the manual (a Claude Code skill).
- `src/claude-config/hooks/coordinator-guard.js` — the default-deny PreToolUse guard.
- `src/claude-config/settings.json` — registers that guard (and pins
  `disableAllHooks: false`).

**Seats get both regardless of cwd.** `tools/autoseat.js` spawns every
coordinator in its conversation's folder (or that tab's worktree) with
`--settings=<repo>/src/claude-config/settings.json` and `--add-dir=<repo>`, and
refuses to start if either is missing. This repo's own `.claude/settings.json`
registers no hooks: a session started here by hand is not guarded. See
CLAUDE.md "THE GUARD".

## Verifying the split is intact

```sh
node /home/hypnodroid/Projects/relay-queue/.claude/skills/relay-coordinator/validate-routing.js
```

Fails if a routing-table row points at a file that does not exist, if a
reference file has no row (so would never be read), or if references
cross-reference each other incorrectly.
