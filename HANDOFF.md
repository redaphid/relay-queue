# HANDOFF - folder scopes (branch `folder-scopes`), 2026-09-19

> **When this objective is complete** (feature merged AND the post-deploy
> migration done): delete this file, and remove the "Active handoff" note and
> the `@HANDOFF.md` line near the top of `CLAUDE.md`.

The design is in **`FOLDER-SCOPES-SPEC.md`** (items 1-7, decisions, migration
curls, verify-before-relying). This file is status plus the context that is
not in the code. The previous root handoff was moved to `handoffs/HANDOFF-2026-08-28.md`;
older handoffs (`HANDOFF-2026-09-02.md`, `HANDOFF-RESUME-NOTES.md`) are in
`handoffs/` too.

---

## DO NOT MERGE TO MAIN UNTIL THIS IS COMPLETE

**Merging to main deploys.** The `relay-queue-sync` sidecar pulls `origin/main`
into the live checkout every 60s, the container serves that checkout read-only
at `/app`, and `server.js` restarts itself when its source changes. There is no
staging step.

**The repo-level guard removal must land in the same deploy as the
`--settings` seat change.** If `.claude/settings.json` loses its `hooks` key
before autoseat passes `--settings .claude/seat-settings.json`, relay
coordinators run UNGUARDED - silently: no error, no log line, default-deny
becomes default-allow. Conversely, if autoseat moves seats out of the repo cwd
before `--settings` is wired, same result. One commit, one deploy.

Work only in a worktree (this one: `~/Projects/relay-queue-folder-scopes`).
Never edit files in `~/Projects/relay-queue` - editing it IS deploying. Never
point self-tests at port 3901 or `/mnt/d/projects/relay-queue/data`; check
`tools/harness-lib.js` for how selftests isolate (temp data dir, other port)
before running one.

---

## STATUS

Implementation: **not started.** The previous session read the code, ran part
of the empirical checks, and was stopped by the owner to hand off. No code on
this branch differs from `origin/main` (c0adfd3) except these docs.

| Spec item | Status | Where to work |
|---|---|---|
| 1. conversation `path` field + validation | not started | create: `POST /conversations` handler in `server.js` (find by grep); patch: `server.js` ~7204 (`body.archived` block is the pattern; the "nothing to update" 400 at ~7342 lists fields - add `path`); record shape ~424 and ~498 (`archived: false, archivedAt: null`); list/get projection ~3420 |
| 2. `GET /conversations?path=` | not started | list filter `server.js` ~8163 (archived filter); router `async function route` ~8109 |
| 3. page routing for deep paths | not started | fallthrough 404 at the end of `route()` in `server.js`; `public/sw.js` (578 lines) navigation handling; `public/manifest.webmanifest` scope |
| 4. UI scope | not started | `public/index.html` (8523 lines): drawer list fetch, create-conversation POST, SSE conversation-frame handler / hamburger unread dot, remembered-active-conversation localStorage key |
| 5. seats in folder, guard via `--settings` | not started | `tools/autoseat.js`: `spawnCoordinator` 823 (spawn at 865 uses `cfg.cwd`; args built 854-856), tab record written 842-845, `selectSeats` 205 (resume decision `row.resumeSessionId` at 333 - compare stored `cwd`), `tick` 1026 (per-pick re-read 1152-1204 has `live` conversation - read `live.path` there), `parseArgs` 1272 (SECURITY-COUPLED comment 1309-1327, `cwd` default 1327, `--cwd` flag 1346, USAGE 1372), exports 1443. New `.claude/seat-settings.json` + `.gitignore` whitelist. Remove `hooks` from `.claude/settings.json` (it also holds a large `permissions.allow` list - keep that, keep the file). Audit `.claude/hooks/coordinator-guard.js` (1107 lines) for cwd-relative paths. |
| 5. selftest | not started | `tools/autoseat-selftest.js` (846 lines) asserts the default cwd holds skill+guard - replace per spec |
| 6. docs | not started | `CLAUDE.md` THE GUARD section; README Conversations (~line 731-872, API table ~1325); `openapi.json`; `.claude/skills/relay-coordinator/SKILL.md` + `references/autoseat.md` |
| 7. spec file | **done** | `FOLDER-SCOPES-SPEC.md` |

Selftests run so far: **none.**

Known broken bits: none in code (nothing changed). The empirical probe script
had a bug (below).

## Empirical checks (Claude Code 2.1.275 in WSL `survivor`)

Script: `/tmp/fs-emp.sh`, scratch dir `/tmp/fs-emp` (throwaway; may be gone).

- **a / b (`--settings` hook fires from another cwd; identical hook in project
  settings runs once or twice): INCONCLUSIVE.** Probe bug: `--allowedTools` is
  variadic and swallowed the prompt, so claude errored "Input must be provided
  either through stdin or as a prompt argument". Fix: put the prompt first, or
  use `--allowedTools=Bash(echo:*)`. **(a) must pass before shipping** - it is
  the whole guard mechanism.
- **c (`--add-dir` loads that dir's skills): INCONCLUSIVE.** The grep on the
  first stream-json line found nothing for either the add-dir run or the
  control; the init event may not list skills under that name. Check
  `/tmp/fs-emp/c.jsonl` or ask the session to list its skills.
- **d (`--resume` from a different cwd): PASS.** Session created in
  `/tmp/fs-emp/proj`, resumed from `/tmp/fs-emp/other`, recalled the code word.

Gotcha for the next session: running `wsl -d survivor -- bash -lc '...'` from
Windows Git Bash expands `$VARS` before bash sees them (and Git Bash rewrites
`/tmp/...` paths unless `MSYS_NO_PATHCONV=1`). Write scripts to a file (e.g.
via `\\wsl.localhost\survivor\tmp\...`) and run `bash /tmp/x.sh` - or just work
from inside WSL, which the new session will.

---

## Context from the planning session (not in the code)

### Where relay runs (verified 2026-09-19)

- Container `relay-queue` (node:22-alpine) in Docker Desktop's engine (the
  `docker-desktop` WSL2 distro), composed from survivor's
  `~/Projects/relay-queue`, which is bind-mounted read-only at `/app`.
- Data stays on NTFS at `/mnt/d/projects/relay-queue/data`.
- Nothing on the Windows host listens on 3901; Windows reaches it through WSL
  mirrored networking.
- A second service `relay-queue-sync` (alpine/git) pulls `origin/main` into the
  live checkout every 60s with a read-only deploy key.
- Autoseat (`tools/autoseat.js`) runs in WSL as a host process; it is the only
  thing that spawns `claude`.

### The stale D: checkout

- `D:\Projects\relay-queue` is a full STALE checkout (at 4b83866), not
  data-only as `D:\Projects\CLAUDE.md` claims.
- Its `.claude/settings.json` (Windows-path guard registration) was renamed to
  `settings.json.stale-20260919` on 2026-09-19 because it was guarding
  unrelated sessions started there.
- `D:\Projects\CLAUDE.md`'s relay section (cwd/skill/guard coupling, "D: holds
  only data/") needs updating once this ships.

### Owner decisions

- URL path = folder relative to WSL home; `/` = everything (today's view); a
  scope shows its folder and all descendants.
- Seats are ALWAYS guarded coordinators, cwd = the folder.
- Relay adds ONLY its own checked-in settings (`.claude/seat-settings.json` via
  `--settings`) on top of each folder's own `.claude/settings.json` /
  `settings.local.json`, which load normally. Relay must never manage or know
  about project-specific settings.
- The repo-level guard registration in relay-queue is removed - "when I want
  coordinator mode, I'll start a session in relay" (i.e. coordinator mode = a
  session started by relay; manual sessions in the repo are not guarded).
- No per-folder permissions UI, no home mount into the container, no compose
  changes.

### Open security note (not addressed by this feature)

Port 3901 is published on all interfaces with no app auth (see
`docker-compose.yml` comments and `.github-drafts/authenticate-the-queue.md`).
Anyone on LAN/Tailscale can post and make agents act. Folder scopes make that
somewhat worse (a posted conversation can now choose which home folder a
guarded coordinator runs in) - worth a sentence in the PR.

### Claude Code facts (from docs)

- `--settings` ranks above user/project/local, below managed.
- List keys (`permissions.allow/deny/ask`) merge across sources; deny beats
  allow; scalar keys take the highest-precedence value.
- `--add-dir` loads that dir's `.claude/skills`.
- PreToolUse hook input has `agent_id` only for subagent calls (the guard's
  subagent exemption depends on it).
- `--resume` works from any cwd since v2.1.223 (and empirically on 2.1.275).
- Unverified: `--setting-sources` behavior, hook dedup across sources.

---

## Next steps

1. Re-run empirical checks a, b, c correctly (see above). If (a) fails, stop
   and rethink the guard injection before writing code.
2. Server: `path` normalizer (one function, used for body field and query
   param), create + patch + record projection + SSE frame, `?path=` filter.
   Then the navigation fallback in `route()` and `public/sw.js`.
3. UI in `public/index.html`: scope from `location.pathname`, breadcrumb,
   scoped drawer, create with `path`, per-scope remembered conversation,
   out-of-scope SSE frames do not light the dot. Verify `/` is unchanged.
4. Guard audit (`coordinator-guard.js`): resolve log/state paths from
   `__dirname`; make sure nothing writes into the cwd.
5. Autoseat + `.claude/seat-settings.json` + `.gitignore` whitelist + removal
   of `hooks` from `.claude/settings.json` - **one commit**. Missing-folder
   message (once per conversation+path), cwd in tab record, fresh session on
   path change.
6. `tools/autoseat-selftest.js` assertions per spec; run it and the other
   relevant selftests (`coordinator-guard-selftest.js`, `ui-selftest.js`,
   `replay-selftest.js`, `lifecycle-selftest.js`) after checking
   `tools/harness-lib.js` isolation.
7. Docs (spec item 6).
8. Only then: review, merge, watch the deploy, run the migration in
   `FOLDER-SCOPES-SPEC.md`, update `D:\Projects\CLAUDE.md`, delete this file.
