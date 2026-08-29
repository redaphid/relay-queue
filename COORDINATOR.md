# relay-queue — coordinator manual (moved)

**This manual is now a Claude Code skill. Read it before you do anything else.**

```
D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md
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

As of **2026-08-29** both live in this repository, under `.claude/`:

- `.claude/skills/relay-coordinator/` — the manual (a Claude Code skill).
- `.claude/hooks/coordinator-guard.js` — the default-deny PreToolUse guard.
- `.claude/settings.json` — registers that guard.

They were moved here from `D:\projects\.claude` so they are versioned with the
server they describe.

**This is coupled to `tools/autoseat.js`.** Autoseat spawns every coordinator
with `cwd: D:\projects\relay-queue`, and Claude Code discovers `.claude/skills/`
and loads `.claude/settings.json` only for the directory a session is rooted in.
Change that cwd and the coordinator boots with **no protocol and no guard** —
nothing errors, and the guard's default-deny silently becomes default-allow.
The cwd, the skill and the guard registration move together or not at all.

## Verifying the split is intact

```sh
node D:/projects/relay-queue/.claude/skills/relay-coordinator/validate-routing.js
```

Fails if a routing-table row points at a file that does not exist, if a
reference file has no row (so would never be read), or if references
cross-reference each other incorrectly.
