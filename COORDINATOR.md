# relay-queue — coordinator manual (moved)

**This manual is now a Claude Code skill. Read it before you do anything else.**

```
D:\projects\.claude\skills\relay-coordinator\SKILL.md
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

`D:\projects\CLAUDE.md` tells every coordinator to read `COORDINATOR.md`, and
this repository has **no `CLAUDE.md` and no `.claude/` of its own** — nothing
auto-injects the manual. Deleting or emptying this file means a coordinator
boots with no protocol at all, silently. Leave the pointer here.

## Verifying the split is intact

```sh
node D:/projects/.claude/skills/relay-coordinator/validate-routing.js
```

Fails if a routing-table row points at a file that does not exist, if a
reference file has no row (so would never be read), or if references
cross-reference each other incorrectly.
