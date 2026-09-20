# Folder scopes - spec

Status: owner-approved design, 2026-09-19. Implementation NOT started - see
`HANDOFF.md`.

Follow-up: **`FOLDER-BROWSE-SPEC.md`** adds `GET /fs` and `POST /folder-index`
on top of this - the host publishes a home directory index so the drawer can
list, and the path box can autocomplete, folders that hold no tab yet.
`GET /folders` below is unchanged and stays derived from conversation paths.

## Goal

Relay URL paths map to folders relative to the owner's WSL home
(`/home/hypnodroid`). `https://relay.hypnodroid.com/Projects/relay-queue` looks
exactly like relay today, but scoped to that folder, and the Claude sessions
relay seats for conversations there run with that folder as cwd.

`/` is the home root and shows everything - identical to relay today.

## 1. Conversation `path`

- New optional field on conversation records, home-relative.
- Normalized: no leading/trailing slash, no `.`/`..` segments, no empty
  segments, no backslashes. Anything invalid is rejected with **400**.
- `""` / absent = home root.
- Settable on `POST /conversations` (create) and on the existing patch route
  `POST /conversations/:id` (the one that takes `title`, `agent`, `archived`;
  handler around `server.js:7204`).
- Included in list/get records and in SSE `conversation` frames.
- Old records without it replay as root. **No log rewrite** - the event log is
  append-only; a missing field just means `""`.

## 2. Scoped listing

- `GET /conversations?path=Projects` returns conversations whose path equals
  `Projects` or is under `Projects/` (all descendants). Prefix match on whole
  segments only: `Projects` must not match `ProjectsOld`.
- No `path` param = everything (unchanged behavior).
- Stacks with the existing filters (`archived=1`, `archived=only`, ...; the
  list filter is around `server.js:8163`).
- The `path` query value is normalized with the same function as the field;
  an invalid one is a 400.

## 3. Page routing

- For GET requests that match no API route and look like a browser navigation
  (`Accept` includes `text/html`, or `Sec-Fetch-Mode: navigate`), serve the
  index page instead of 404.
- API clients (curl, default `Accept: */*`) still get the existing JSON 404.
- Check `public/sw.js`: a navigation to a deep path must get the app shell,
  not a cached 404. Check the manifest `scope`/`start_url` and the SW scope
  still cover deep paths (SW registered at `/` covers all of them).
- All page requests are root-relative already, so deep paths need no `<base>`.
  Verify nothing in `public/index.html` uses a relative URL.

## 4. UI scope

- The page derives its scope from `location.pathname`: `decodeURIComponent`,
  then the same normalization as (1). `/` = root.
- Header shows the scope as a breadcrumb; each segment links to its ancestor
  scope (`/`, `/Projects`, `/Projects/relay-queue`).
- The conversation drawer lists only conversations in scope (`?path=<scope>`).
  Each row is labeled with its sub-path relative to the scope when it is not
  exactly the scope.
- New conversations are created with `path` = current scope.
- Unread dot / SSE: frames for out-of-scope conversations must not light the
  hamburger dot.
- The remembered active conversation is per scope (e.g. localStorage key
  suffixed with the scope). If the remembered one is out of scope, fall back
  sanely (first in-scope conversation; `main` only at root).
- At `/` behavior must be byte-for-byte what it is today.

## 5. Seats run in the folder, still guarded, guard decoupled from cwd

- New checked-in file **`.claude/seat-settings.json`**, containing ONLY relay's
  own settings for every seat: the PreToolUse registration of
  `coordinator-guard.js` - same matcher (`Bash|PowerShell|Write|Edit|NotebookEdit`),
  timeout (15) and statusMessage as today's `.claude/settings.json`, with the
  absolute node path (`/home/hypnodroid/.local/share/fnm/aliases/default/bin/node`)
  and the absolute guard path
  (`/home/hypnodroid/Projects/relay-queue/.claude/hooks/coordinator-guard.js`).
  Nothing project-specific. Relay code never reads, writes or knows about any
  project's own settings. Remember to whitelist it in `.gitignore`
  (`!.claude/seat-settings.json` - `.claude/*` is ignored by default).
- `tools/autoseat.js` spawns each coordinator with
  `cwd = path.join(os.homedir(), conversation.path)`, plus
  `--settings <abs path to seat-settings.json>` and
  `--add-dir <relay-queue repo root>` (so the relay-coordinator skill loads).
  Both derived from the repo location (`path.resolve(__dirname, '..')`), not
  from hardcoded project names.
- If the folder does not exist: do NOT spawn, never fall back to another cwd.
  Post one clear message into that conversation saying the folder is missing;
  do not repeat it every tick (remember per conversation+path that it was
  reported).
- Store the cwd in the tab state record (`state.tabs[cid].cwd`). If the
  conversation's path changed since its session was created, start a fresh
  session instead of resuming.
- **Remove the guard registration (the `hooks` key) from the repo's
  `.claude/settings.json`.** That file also carries a `permissions.allow` list,
  so the file stays with only that; delete it only if the guard was all it
  held. Leave `.claude/settings.local.json` alone. The guard script, its
  selftest and the skill stay. **This MUST be in the same commit as the
  `--settings` change**, so there is never a deployed state where seats run
  unguarded.
- Audit `.claude/hooks/coordinator-guard.js` for anything cwd- or
  project-dir-relative (`CLAUDE_PROJECT_DIR`, `process.cwd()`, relative paths
  for `.claude/coordinator-violations.log`, `.guard-mainthread-seen`, temp or
  markdown path checks). With cwd now an arbitrary project folder the guard
  must still log into the relay-queue repo (resolve from `__dirname`), never
  write files into the project folder, and its allow rules must keep working.
- `tools/autoseat-selftest.js`: replace the assertion about the default cwd
  with assertions that the spawned args include `--settings` pointing at an
  existing file that registers the guard, `--add-dir` pointing at a dir that
  contains `.claude/skills/relay-coordinator/SKILL.md`, and that the spawn cwd
  follows the conversation path (and that a missing folder spawns nothing).

## 6. Docs

- `CLAUDE.md` "THE GUARD" / "Do not break the registration": the guard is
  applied per seat via `--settings`; manual sessions in the repo are NOT
  guarded, by the owner's choice; coordinator mode = a session started by relay.
- The SECURITY-COUPLED comment in `tools/autoseat.js` `parseArgs`.
- README "Conversations": the `path` field and the `?path=` filter.
- `openapi.json` (authored; `openapi.yaml` is generated) where it describes
  conversation records and `GET /conversations` params.
- `.claude/skills/relay-coordinator` (SKILL.md, `references/autoseat.md`) where
  they state the cwd coupling.
- Afterwards, outside this repo: `D:\Projects\CLAUDE.md` relay section.

## 7. Decisions

- Coordinators are **always guarded**. There is no unguarded seat mode.
- Relay adds **only its own settings** (`.claude/seat-settings.json` via
  `--settings`) on top of each folder's own `.claude/settings.json` /
  `settings.local.json`, which load normally.
- No per-project settings managed by relay. No per-folder permission UI.
- The server never touches home folders: no home-directory mount into the
  container, no docker-compose changes. Only autoseat (a host process in WSL)
  resolves `path` to a directory.
- The migration below is **data, not code**, performed against live relay
  after deploy.

## Migration (after deploy, against live relay - NOT part of the code)

Run from WSL (relay at `http://127.0.0.1:3901`). Bodies are pure ASCII.

1. List every non-archived conversation and eyeball it:

   ```sh
   curl -s http://127.0.0.1:3901/conversations | jq -r '.conversations[] | [.id, .title, (.path // "")] | @tsv'
   ```

2. Identify the Sporefall ones: titles mentioning Sporefall / sporefall-station
   / the game, and ones whose tasks talk about it. A candidate filter to start
   from, then confirm by eye (do not trust it blindly):

   ```sh
   curl -s http://127.0.0.1:3901/conversations?archived=1 \
     | jq -r '.conversations[] | select((.title // "") | test("spore|sporefall"; "i")) | [.id, .title, .archived] | @tsv'
   ```

   For ambiguous titles, read the tab: `curl -s "http://127.0.0.1:3901/thread?conversation=<id>"`
   (or `GET /tasks?conversation=<id>`). Do not hardcode ids in any script -
   write the confirmed list down first.

3. File each confirmed Sporefall conversation under the game folder:

   ```sh
   curl -s -X POST http://127.0.0.1:3901/conversations/<id> \
     -H 'content-type: application/json' --data-binary @- <<'J'
   {"path":"Projects/sporefall-station"}
   J
   ```

4. Archive every other non-archived conversation except `main` (which cannot
   be archived - the server returns 400):

   ```sh
   curl -s -X POST http://127.0.0.1:3901/conversations/<id> \
     -H 'content-type: application/json' --data-binary @- <<'J'
   {"archived":true}
   J
   ```

   Archiving a tab with a seated coordinator makes autoseat retire it on its
   next tick (see `tools/autoseat.js` tick, "the tab was archived or stopped").

5. Verify: `GET /conversations?path=Projects/sporefall-station` lists exactly
   the Sporefall ones; `GET /conversations` lists those plus `main`.

## Verify before relying on (Claude Code behavior)

Installed: `claude --version` = **2.1.275** (WSL `survivor`, `~/.local/bin/claude`).
Empirical results so far (2026-09-19, throwaway dirs under `/tmp/fs-emp`,
script `/tmp/fs-emp.sh`):

| Check | Result |
|---|---|
| a. `--settings` PreToolUse hook fires in a `-p` session whose cwd is another folder | **INCONCLUSIVE** - the probe was malformed: `--allowedTools` is variadic and swallowed the prompt ("Input must be provided..."). Re-run with the prompt BEFORE the flags or `--allowedTools=...`. |
| b. identical hook command in both `--settings` and the cwd's `.claude/settings.json`: once or twice? | **INCONCLUSIVE**, same probe bug. Docs say nothing definite about dedup - unverified. The guard is idempotent for allow/deny, but a double run would double-log violations. |
| c. `--add-dir <dir>` makes `<dir>/.claude/skills/*` available | **INCONCLUSIVE** - the grep on the init event printed nothing for both the add-dir run and the control; inspect `/tmp/fs-emp/c.jsonl` (look for `skills` / `slash_commands` in the `system/init` event) or ask the session to list its skills. |
| d. `--resume <id>` from a different cwd than the session started in | **PASS** - started in `/tmp/fs-emp/proj` with `--session-id`, resumed from `/tmp/fs-emp/other`, recalled the code word. |

Docs claims (unverified here): `--settings` ranks above user/project/local and
below managed; list keys (`permissions.allow/deny/ask`) merge across sources;
deny beats allow; scalar keys take the highest-precedence value; `--add-dir`
loads that dir's `.claude/skills`; PreToolUse hook input has `agent_id` only for
subagent calls; `--resume` works from any cwd since v2.1.223. `--setting-sources`
behavior and hook dedup are unverified.

If (a) fails, the whole design needs a different guard-injection mechanism -
do not ship without it passing. If (c) fails, point the brief at the absolute
SKILL.md path instead (the brief already names COORDINATOR.md absolutely).
