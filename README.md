# relay-queue

A minimal, durable, **local-only** HTTP message queue with a mobile web UI.

It carries messages between a **human** and their **agents**. The human types into the web UI on
a phone; an agent claims the message, does the work, and posts a result, which appears back in
the thread. It is also still the agent-to-agent hand-off channel it started as — a **Communicator**
(posts tasks, reads results back) and a **Coordinator** (claims tasks, posts results) — so that
nothing is lost while long background work is running. The agent side is driven by hand with `curl`.

- **Zero runtime dependencies.** Node built-ins only (`node:http`). No npm install, no `node_modules`.
  The UI is one self-contained HTML file — inline CSS and JS, no frameworks, no CDN, no external requests.
- **Durable.** Every mutation is appended to `data/events.jsonl` and fsynced *before* the HTTP
  response is sent, then replayed into memory on boot. A crash right after a `200` cannot lose a write.
- **Local only.** Binds `127.0.0.1` by default; the Docker port mapping is pinned to `127.0.0.1` too.
- **No auth**, no priorities, no TLS. Put it behind an authenticating proxy before exposing it.

Web UI: **http://127.0.0.1:3901/** &nbsp;&nbsp; API base: **http://127.0.0.1:3901**

---

## The web UI

Open **http://127.0.0.1:3901/** — one page, no build step, no login.

What you see, top to bottom: a `relay` header (which grows an `offline — retrying` note if the
server goes away), the message thread, then a textarea and a **Send** button pinned to the bottom.

- **The thread** runs oldest at the top, newest at the bottom, and auto-scrolls to the bottom on
  load and whenever something new arrives. If you have scrolled up to read history it leaves you
  where you are instead of yanking you down.
- **Your messages** are right-aligned and blue, with a relative time (`now`, `7m`, `3h`, `2d`) and a
  status marker: `pending` (nobody has picked it up), `claimed` (an agent is working on it), or
  `answered` (the reply is below it). Tap-and-hold the time to see the exact timestamp.
- **Agent replies** are left-aligned in a bordered bubble, directly under the message they answer.
- **Sending**: tap **Send**, or press **Ctrl+Enter** / **Cmd+Enter**. The box only clears once the
  server has accepted the message; if the send fails your text stays put and a one-line reason
  appears above the composer. Messages are capped at 8000 characters.
- **Newlines and whitespace are preserved** exactly. Message text is written with `textContent`,
  never `innerHTML`, so a message containing HTML or `<script>` is displayed literally as text and
  cannot execute.
- **Updates** arrive by polling `GET /thread?since=…` every ~3 s, fetching only what changed. Polling
  pauses while the tab is hidden, backs off up to 20 s if the server is unreachable, and recovers on
  its own — the page survives the service restarting under it without a reload. Nothing you have
  typed is ever overwritten by a refresh.
- **Mobile-first**: 16 px minimum text (so iOS does not zoom on focus), 48 px tap targets, no
  horizontal scroll, safe-area padding, and it follows your system light/dark setting.

The page contains **no secrets and no absolute URLs** — every request is root-relative (`/tasks`,
`/thread`), so it works unchanged behind a path-preserving reverse proxy on another hostname. It is
served with `content-security-policy: default-src 'none'; … connect-src 'self'`, which forbids the
page from making any external request at all.

The page lives at **`public/index.html`** and is read from disk on request (re-read when its mtime
changes, so editing it needs no restart). The server looks for it at `$UI_FILE`, then
`public/index.html`, then `<DATA_DIR>/ui/index.html`, and logs which one it picked at boot.

> **Docker note:** the compose file bind-mounts `server.js`, `package.json` and `data/` individually,
> **not** the repo root — so `public/` is not visible inside the container. Until compose gains
> `- ./public:/app/public:ro`, the container falls back to `<DATA_DIR>/ui/index.html`; after editing
> `public/index.html` re-copy it (`cp public/index.html data/ui/index.html`) and restart. `GET /`
> answers `503` with the list of paths it searched if it finds no page at all.

---

## Start it

### Option A — Docker (the normal way)

```bash
cd /d/projects/relay-queue && docker compose up -d
```

Uses the stock `node:22-alpine` image with the source bind-mounted read-only — there is no image
to build. Container name is `relay-queue`, `restart: unless-stopped`, so it comes back with Docker
Desktop. `data/` is bind-mounted to `D:/projects/relay-queue/data`, the same directory bare Node uses.
Because the mounts are per-file (`server.js`, `package.json`) plus `data/`, adding `public/` to the
container needs a `- ./public:/app/public:ro` line in compose — see the note under
[The web UI](#the-web-ui) for the fallback used until then.

```bash
docker compose logs -f relay-queue    # follow logs
docker restart relay-queue            # restart (queue survives)
docker compose down                   # stop and remove
```

### Option B — bare Node (fallback, identical behaviour)

```bash
node D:\projects\relay-queue\server.js
```

Stop the container first, or the port will be taken. Both paths read and write the same
`data/events.jsonl`, but **do not run both at once** — two writers appending to one log will
interleave and each process only sees its own in-memory state.

### Configuration

| Env var    | Default             | Notes                                              |
| ---------- | ------------------- | -------------------------------------------------- |
| `PORT`     | `3901`              |                                                     |
| `HOST`     | `127.0.0.1`         | The container sets `0.0.0.0`; the published port is still `127.0.0.1`-only. |
| `DATA_DIR` | `<repo>/data`       | Where `events.jsonl` lives.                         |

---

## The thread model

There is **one** record type and **one** write path. A message from the human *is* the task; the
agent's reply *is* that task's result. Nothing new is stored:

```
task record                         thread entries derived from it
-----------------------------       ----------------------------------------------
{ role:"user", instruction:"…",  ->  { id:"<id>",    role:"user",  text:<instruction> }
  result:"…" }                  ->  { id:"<id>:r",  role:"agent", text:<result>, replyTo:"<id>" }
```

`GET /thread` is a **read-only projection** of the same task records, flattened into chronological
order. Every task yields one entry carrying its role (`"user"` unless stated otherwise), and a task
that has a result *also* yields a derived `role:"agent"` entry with id `<taskId>:r` and `replyTo`
pointing at its parent.

**So an agent replies to the human with exactly one call: `POST /tasks/:id/result`.** There is no
separate reply endpoint, and claim/result semantics are completely unchanged.

A thread entry:

```json
{
  "id": "msjfwakm-pgrjbw",
  "role": "user",
  "text": "sample: how many widgets are left?",
  "ts": "2026-01-01T00:00:00.000Z",
  "status": "pending",
  "rev": "2026-01-01T00:00:00.000Z"
}
```

`ts` is immutable and sets display order. **`rev`** is the last-changed time —
`max(ts, claimedAt, resultTs)` — and is what `since=` filters on, so a status change
(`pending` -> `claimed` -> `done`) reaches an incrementally polling client even though `ts` never
moves. Clients track the highest `rev` they have seen and upsert entries by `id`.

## Task lifecycle

```
POST /tasks                 ->  status: pending    (role: "user")
POST /tasks/:id/claim       ->  status: claimed    (409 if already claimed or done)
POST /tasks/:id/result      ->  status: done       (409 if already done)
```

`claim` is optional — you may post a result straight onto a `pending` task. A task takes **one**
result, so each message gets one reply.

In the UI, `pending` / `claimed` / `done` are shown on your own messages as
**pending** / **claimed** / **answered**.

**`relayed` is a separate axis from `status`.** It defaults to `false` and means "the Communicator
has already shown this result to the human". A task can be `done` but not yet relayed; that is
exactly the set you want to poll for. `unread=true` is shorthand for `relayed=false`.

A task record:

```json
{
  "id": "msjfwakm-pgrjbw",
  "role": "user",
  "instruction": "sample: summarise the widget report",
  "from": "communicator",
  "ts": "2026-01-01T00:00:00.000Z",
  "status": "pending",
  "claimedBy": null,
  "claimedAt": null,
  "result": null,
  "resultTs": null,
  "relayed": false,
  "relayedAt": null
}
```

All timestamps are ISO 8601 and are set server-side. `id` is URL-safe (base36 time + random).

`role` was added alongside the UI and is always **set by the server** — `role`, `id`, `ts`, `status`
and `relayed` in a request body are ignored. Records written before `role` existed replay as
`role:"user"`, so old logs load unchanged.

`instruction` is capped at **8000 characters** (`400` above that). `result` is not capped beyond the
1 MiB body limit, since it comes from the trusted agent side.

---

## curl cheat-sheet

Every command is copy-pasteable as-is (Git Bash). Add `-i` to see status codes.

**Health + queue counts** — returns `{status, name, version, counts:{pending,claimed,done,unrelayed}, uptimeSec}`.

```bash
curl -s http://127.0.0.1:3901/health
```

**Create a task** — returns `201` and the new task record (grab `.id` from it). Always `role:"user"`.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks \
  -H 'content-type: application/json' \
  -d '{"instruction":"sample: check the widget inventory","from":"communicator"}'
```

`text` is accepted as an alias for `instruction` (it is what the UI sends); the response always
returns `instruction`. These two are identical:

```bash
curl -s -X POST http://127.0.0.1:3901/tasks -H 'content-type: application/json' -d '{"text":"sample: hello"}'
curl -s -X POST http://127.0.0.1:3901/tasks -H 'content-type: application/json' -d '{"instruction":"sample: hello"}'
```

**List all tasks** — returns `{count, tasks:[...]}` in creation order.

```bash
curl -s http://127.0.0.1:3901/tasks
```

**List only pending tasks** — what the Coordinator polls for new work.

```bash
curl -s 'http://127.0.0.1:3901/tasks?status=pending'
```

**Claim a task** — returns `200` + the task with `status:"claimed"`; `404` unknown id, `409` if already claimed or done.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/claim \
  -H 'content-type: application/json' \
  -d '{"by":"coordinator"}'
```

**Post a result — this is also how an agent replies to the human.** Returns `200` + the task with
`status:"done"` and `resultTs` set; `409` if it already has a result. The reply shows up in the UI
thread as a `role:"agent"` bubble under the message it answers. One call, nothing else needed:

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/result \
  -H 'content-type: application/json' \
  -d '{"result":"sample: 42 widgets on hand, 3 backordered"}'
```

**Read the thread** — the human+agent conversation in chronological order, oldest first.

```bash
curl -s http://127.0.0.1:3901/thread
```

**Poll the thread incrementally** — `since` filters on `rev` (last-changed), **strictly after**, and
accepts ISO 8601 or epoch ms. This is what the UI does every ~3 s; it returns new messages, new
replies *and* status changes to messages you have already seen.

```bash
curl -s 'http://127.0.0.1:3901/thread?since=2026-01-01T00:00:00Z'
```

**Read the tail of the thread** — on `/thread`, `limit` takes the **most recent** N entries (a thread
is read from the end). Note this is the opposite of `/tasks?limit=`, which takes the first N.

```bash
curl -s 'http://127.0.0.1:3901/thread?limit=20'
```

**Get finished results the human has not seen yet** — the Communicator's main poll; returns `{count, tasks:[...]}` of `done` + `relayed:false`.

```bash
curl -s 'http://127.0.0.1:3901/results?unread=true'
```

**Mark a result as shown to the human** — returns `200` + the task with `relayed:true`; idempotent, repeat calls keep the original `relayedAt`.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/relayed
```

**Get one task by id** — returns the single task record, or `404`.

```bash
curl -s http://127.0.0.1:3901/tasks/REPLACE_ID
```

**Anything newer than a timestamp** — `since` accepts ISO 8601 or epoch ms and filters on `ts`, **strictly after**.

```bash
curl -s 'http://127.0.0.1:3901/tasks?since=2026-01-01T00:00:00Z'
```

**Combine filters** — `status`, `unread`, `since` and `limit` all stack; `limit` takes the first N.

```bash
curl -s 'http://127.0.0.1:3901/tasks?status=done&unread=true&limit=5'
```

### Handy one-liners

**Answer the human's oldest waiting message in one line** — the whole agent loop, condensed:

```bash
curl -s 'http://127.0.0.1:3901/tasks?status=pending&limit=1' | grep -o '"id": "[^"]*"' | cut -d'"' -f4 \
  | xargs -I{} curl -s -X POST "http://127.0.0.1:3901/tasks/{}/result" \
      -H 'content-type: application/json' -d '{"result":"sample: on it — 42 widgets on hand"}'
```

Create a task and keep its id:

```bash
ID=$(curl -s -X POST http://127.0.0.1:3901/tasks -H 'content-type: application/json' \
  -d '{"instruction":"sample task","from":"communicator"}' | grep -o '"id": "[^"]*"' | cut -d'"' -f4)
echo "$ID"
```

Send a multi-line or quote-heavy result without fighting the shell:

```bash
curl -s -X POST "http://127.0.0.1:3901/tasks/$ID/result" \
  -H 'content-type: application/json' \
  --data-binary @- <<'JSON'
{"result":"sample: line one\nline two with \"quotes\""}
JSON
```

### Endpoint summary

| Method | Path                  | Purpose                                                        |
| ------ | --------------------- | -------------------------------------------------------------- |
| GET    | `/`                   | **new** — the mobile web UI (`text/html`; `503` if the page file is missing) |
| GET    | `/health`             | liveness + counts                                               |
| POST   | `/tasks`              | create (`400` if `instruction`/`text` missing or over 8000 chars) |
| GET    | `/tasks`              | list; `status` `unread` `since` `limit` (first N)               |
| GET    | `/tasks/:id`          | one task                                                        |
| POST   | `/tasks/:id/claim`    | pending -> claimed (`404`/`409`)                                |
| POST   | `/tasks/:id/result`   | -> done, **and posts the agent's reply into the thread** (`404`/`409`) |
| GET    | `/results`            | done tasks only; `unread` `since` `limit`                       |
| POST   | `/tasks/:id/relayed`  | mark shown to human (idempotent)                                |
| GET    | `/thread`             | **new** — chronological human+agent view; `since` (on `rev`) `limit` (last N) |

Changed in 1.1.0, all backward compatible: task records gained a server-set `role`; `POST /tasks`
accepts `text` as an alias for `instruction` and caps it at 8000 chars. Every pre-1.1.0 record and
every pre-1.1.0 curl call keeps working exactly as before.

Unknown routes return `404` JSON, wrong methods `405`, malformed JSON bodies `400`. The server
never crashes on bad input.

---

## Data & git

Queue contents live in **`data/events.jsonl`** — one JSON event per line, append-only:

```
{"t":"create","task":{...}}
{"t":"patch","id":"msjfwakm-pgrjbw","patch":{"status":"claimed",...}}
```

`data/` is **gitignored** and must stay that way — it holds real message text. Only code and docs are
committed. To wipe the queue, stop the service, delete `data/events.jsonl`, start it again.

`data/ui/index.html` is a disposable copy of `public/index.html`, there only so the container can
find the UI until compose mounts `./public` (see the note under [The web UI](#the-web-ui)). It is
not queue state; deleting it is harmless as long as the real `public/index.html` is reachable.

On boot the log is replayed and a torn final line (from a hard kill mid-write) is skipped rather
than fatal; the startup log reports `N events replayed, M skipped`.

The log grows forever. This is intentional — it is the durability mechanism and the volumes here
are tiny. If it ever gets unwieldy, archive the file and restart.
