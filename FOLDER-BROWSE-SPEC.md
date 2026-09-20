# SPEC - browse the real filesystem to pick a folder

Request (2026-09-20, task `mu9916f9-9gidhw`): *"Relay needs to let a user browse
the filesystem if they want to to select a folder."*

## The problem

`GET /folders` is **derived only from conversation paths**. A folder that holds
no tab does not exist as far as the drawer is concerned, so filing a tab
anywhere new means typing the path blind into `#foldpath` and hoping it exists
in WSL. Getting it wrong is silent: autoseat spawns nothing and posts one note.

The server cannot fix this itself. It runs in a container with **no home mount,
by the owner's decision** (`HANDOFF.md`, "Owner decisions"), and
`docker-compose.yml` mounts only the checkout (ro) and `data/`.

## The design: the host publishes an index, the server serves it

Do **not** mount home into the container. `tools/autoseat.js` is already the
only host process, already has home access, and already has a relay client
(`postJson`). It publishes a directory index; the server stores and serves it.

Staleness is acceptable here - this is a folder *picker*, not a file manager.

### 1. autoseat: scan and publish

- Walk `$HOME` for directories only:
  - depth <= **4** below home,
  - skip any name starting with `.`, plus `node_modules`, `__pycache__`,
    `venv`, `dist`, `build`,
  - **do not follow symlinks** (`withFileTypes`, `d.isDirectory()` only),
  - stop at **4000** entries and set `truncated: true`.
- Publish on start, then every **180s**. Skip the POST when the payload is
  byte-identical to the last one sent.
- `RELAY_FOLDER_INDEX=0` disables it entirely.
- A failed POST is logged once and retried on the next tick. It must never
  affect seating - this is a bonus, not a dependency.

### 2. `POST /folder-index`

```json
{"root":"~","scannedAt":"<iso>","truncated":false,"dirs":["Projects","Projects/app"]}
```

- Each entry is validated with the existing `normaliseConvPath`; invalid ones
  are dropped, not fatal. Reply reports `stored` and `dropped`.
- Written atomically to `data/folder-index.json` (tmp + rename, as
  `server.js:3940` does), and held in memory.
- Emits **no** SSE event: it is not conversation traffic.

### 3. `GET /fs?path=<scope>`

```json
{"path":"Projects","scannedAt":"<iso>","ageSec":42,"stale":false,"truncated":false,
 "known":true,"count":2,
 "dirs":[{"name":"app","path":"Projects/app","hasChildren":true,
          "conversations":3,"pending":1,"unread":0}]}
```

- Immediate child directories of `<scope>` from the index, sorted by name in
  plain code-unit order (same rule as `foldersRoute`).
- Counts are merged from the same numbers `GET /folders` reports, so a folder
  that holds tabs shows them; one that does not shows zeros.
- `stale: true` when `ageSec > 600`, or when there is no index at all.
- A scope absent from the index answers `200` with `known:false` and an empty
  list - not a 404. The index is a cache, not the truth.
- A malformed `path` is refused `400` by `normaliseConvPath`, as elsewhere.

### 4. UI (`public/index.html`, Folders section)

- The list keeps showing folders-with-tabs exactly as today. Below them, after
  a thin divider, the **real subfolders that hold no tab yet**, dimmed and
  without a count. Clicking either navigates to `/<path>`, as today.
- `#foldpath` gets a `<datalist>` fed from the index's descendants of the
  current scope, so typing a path autocompletes to folders that actually exist.
- A stale index puts one quiet line in `#folderr` ("folder list is N min old").
- **Any failure of `/fs` leaves the drawer exactly as it is today.** The drawer
  must not break over a bonus - same rule `loadFolders()` already follows.

### 5. Selftest - `tools/folder-browse-selftest.js`

Throwaway instance only (own `DATA_DIR`, own port - `tools/harness-lib.js`).
**Never port 3901, never `/mnt/d/projects/relay-queue/data`.**

Asserts: index round-trips; drilldown at root and at depth; counts merge with
conversation paths; bad `path` is 400; unknown scope is `known:false`, not 404;
invalid entries are dropped rather than stored; `stale` flips past 600s.

## Security note - for the owner, not a blocker

This adds **home directory-name enumeration** to a port with no app auth
(`.github-drafts/authenticate-the-queue.md`). Bounded deliberately: directory
names only, no file names, no contents, depth 4, under home only. Anyone who
can reach 3901 can already file a tab at any path and have a guarded
coordinator seated there, so this exposes strictly less than the existing
write. Say no and the typed-path input stays the only way in.
