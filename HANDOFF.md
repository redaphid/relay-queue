# HANDOFF - folder scopes: shipped, cleanup remaining (2026-09-19)

> **When the "Remaining" list below is done:** delete this file, and remove the
> "Active handoff" note and the `@HANDOFF.md` line near the top of `CLAUDE.md`.
> The latest handoff is always this root `HANDOFF.md`; older ones live in
> `handoffs/`.

Design: **`FOLDER-SCOPES-SPEC.md`**. This file is only current state and what
is left.

## State (verified against live relay, 2026-09-19)

- **Merged and live.** PR #30 (`b92de71`, merge `d385eee` on `main`).
  `GET /folders` answers 200, and a browser navigation to
  `/Projects/relay-queue` gets the app shell.
- **No conversation has a `path` yet.** `GET /folders` returns
  `{"path":"","count":0,"folders":[]}`, and all 95 conversations are still at
  the root. The migration has not run.
- What shipped, beyond the spec:
  - Relay's seat config lives in `src/claude-config/`: `settings.json` holds
    only the guard registration plus `disableAllHooks:false`, next to
    `hooks/coordinator-guard.js`.
  - The project's own `.claude/` now holds only the skill and permissions, with
    no hooks. Claude sessions you start by hand in this repo are unguarded, by
    the owner's choice.
  - autoseat spawns every seat with `--settings=src/claude-config/settings.json`
    and `--add-dir=<repo>`. It runs in the conversation's folder, or, inside a
    git repo, in a per-tab worktree at `~/Worktrees/<repo>/<tab-slug>`.
  - autoseat refuses to start a seat without the guard. For a missing folder it
    spawns nothing and reports the problem once.
  - `GET /folders` and folder drilldown in the drawer.
  - New selftests in `tools/folder-scopes-selftest.js`; `autoseat-selftest.js`
    and `ui-selftest.js` were extended.

## Remaining

1. **Data migration.** Needs the owner's go-ahead, because it archives most
   tabs. The exact curl calls are in `FOLDER-SCOPES-SPEC.md` under "Migration".
   - Every conversation except `main` and the Sporefall ones gets archived.
     `main` can't be archived: it's where posts without a `conversationId`
     land.
   - The Sporefall ones get `path` = `Projects/sporefall-station`, which exists
     in WSL.
   - Identify them by title and confirm with the owner before patching.
2. **The guard's live-write exemption (owner decision).** At
   `src/claude-config/hooks/coordinator-guard.js:992`, `LIVE_CLAUDE` exempts
   only `<live>/.claude`. The guard itself now lives in `src/claude-config/`.
   - Widening the exemption would loosen security, so recommend a change and
     let the owner decide; don't apply it.
   - Also: that deny message (around lines 1019-1023) still describes the old
     worktree convention (`../relay-<topic>`, "nine" worktrees). It doesn't
     mention `~/Worktrees/<repo>/<tab-slug>`. Update the wording.
3. **Update `D:\Projects\CLAUDE.md`,** the signpost for all projects. Its
   relay section is stale:
   - It still describes the cwd/skill/guard coupling. Replace that with: the
     guard is applied per seat via `--settings`, and coordinator mode means a
     session started by relay.
   - It claims `D:\Projects\relay-queue` holds only `data/`. That's false: it's
     a full stale checkout at `4b83866`.
   - The stale checkout's `.claude/settings.json` was renamed to
     `settings.json.stale-20260919` so that it stops guarding sessions started
     there.
4. **Optional:** retire the stale code in `D:\Projects\relay-queue` but keep
   `data/`, which is the live store and is bind-mounted into the container.
5. **Check the live checkout's untracked files.** It has an untracked
   `pnpm-lock.yaml` and `.gitignore.bak-selfupdate`. If `main` ever tracks a
   file at either path, the sync sidecar's pull fails with "untracked working
   tree file would be overwritten", and deploys stop silently.

## Rules that still apply

- **Merging to `main` is deploying.** The `relay-queue-sync` sidecar pulls
  `origin/main` every 60s, and `server.js` restarts when its source changes.
- **Never edit the live checkout** at `~/Projects/relay-queue`; work in a
  worktree.
- **Keep selftests off the live instance:** never port 3901 or
  `/mnt/d/projects/relay-queue/data`. See `tools/harness-lib.js`.

## Context (not in the code)

- **Where relay runs:**
  - Container `relay-queue` runs in Docker Desktop's engine, in the
    `docker-desktop` WSL2 distro.
  - It is composed from survivor's `~/Projects/relay-queue`, which is mounted
    read-only at `/app`.
  - Data stays at `/mnt/d/projects/relay-queue/data`.
  - Nothing on Windows listens on 3901; Windows reaches it through WSL's
    mirrored networking.
  - autoseat runs in WSL as a host process, and it is the only thing that
    spawns `claude`.
- **Owner decisions:**
  - A URL path is a folder relative to the WSL home; `/` shows everything.
  - A scope includes all descendants.
  - Seats are always guarded coordinators.
  - Relay adds only its own settings, on top of each folder's own
    `.claude/settings*.json`. Relay never knows about specific projects.
  - There is no per-folder permissions UI and no home mount into the
    container.
- **Claude Code behavior, verified on 2.1.278:**
  - A hook from `--settings` fires regardless of cwd, and exit code 2 blocks
    the call.
  - An identical hook registered in both `--settings` and project settings
    runs once.
  - `--add-dir` loads `<dir>/.claude/skills`.
  - `--resume` works from any cwd.
- **Open security note:**
  - Port 3901 is published on all interfaces with no app auth; see
    `.github-drafts/authenticate-the-queue.md`.
  - Anyone on the LAN or Tailscale can post, and now also choose which home
    folder a guarded coordinator runs in.
