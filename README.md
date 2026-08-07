# relay-queue

A minimal, durable, **local-only** HTTP task queue.

It exists to hand tasks and results between two agents — a **Communicator** (talks to the
human, posts tasks, reads results back) and a **Coordinator** (claims tasks, does the work,
posts results) — so that nothing is lost while long background work is running. Everything is
driven by hand with `curl`.

- **Zero runtime dependencies.** Node built-ins only (`node:http`). No npm install, no `node_modules`.
- **Durable.** Every mutation is appended to `data/events.jsonl` and fsynced *before* the HTTP
  response is sent, then replayed into memory on boot. A crash right after a `200` cannot lose a write.
- **Local only.** Binds `127.0.0.1` by default; the Docker port mapping is pinned to `127.0.0.1` too.
- **No auth**, no priorities, no TLS. Do not expose this to a network.

Service URL: **http://127.0.0.1:3901**

---

## Start it

### Option A — Docker (the normal way)

```bash
cd /d/projects/relay-queue && docker compose up -d
```

Uses the stock `node:22-alpine` image with the source bind-mounted read-only — there is no image
to build. Container name is `relay-queue`, `restart: unless-stopped`, so it comes back with Docker
Desktop. `data/` is bind-mounted to `D:/projects/relay-queue/data`, the same directory bare Node uses.

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

## Task lifecycle

```
POST /tasks                 ->  status: pending
POST /tasks/:id/claim       ->  status: claimed    (409 if already claimed or done)
POST /tasks/:id/result      ->  status: done       (409 if already done)
```

`claim` is optional — you may post a result straight onto a `pending` task.

**`relayed` is a separate axis from `status`.** It defaults to `false` and means "the Communicator
has already shown this result to the human". A task can be `done` but not yet relayed; that is
exactly the set you want to poll for. `unread=true` is shorthand for `relayed=false`.

A task record:

```json
{
  "id": "msjfwakm-pgrjbw",
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

---

## curl cheat-sheet

Every command is copy-pasteable as-is (Git Bash). Add `-i` to see status codes.

**Health + queue counts** — returns `{status, name, version, counts:{pending,claimed,done,unrelayed}, uptimeSec}`.

```bash
curl -s http://127.0.0.1:3901/health
```

**Create a task** — returns `201` and the new task record (grab `.id` from it).

```bash
curl -s -X POST http://127.0.0.1:3901/tasks \
  -H 'content-type: application/json' \
  -d '{"instruction":"sample: check the widget inventory","from":"communicator"}'
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

**Post a result** — returns `200` + the task with `status:"done"` and `resultTs` set; `409` if it already has a result.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/result \
  -H 'content-type: application/json' \
  -d '{"result":"sample: 42 widgets on hand, 3 backordered"}'
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

| Method | Path                  | Purpose                                              |
| ------ | --------------------- | ---------------------------------------------------- |
| GET    | `/health`             | liveness + counts                                     |
| POST   | `/tasks`              | create (`400` if `instruction` missing)               |
| GET    | `/tasks`              | list; `status` `unread` `since` `limit`               |
| GET    | `/tasks/:id`          | one task                                              |
| POST   | `/tasks/:id/claim`    | pending -> claimed (`404`/`409`)                      |
| POST   | `/tasks/:id/result`   | -> done (`404`/`409`)                                 |
| GET    | `/results`            | done tasks only; `unread` `since` `limit`             |
| POST   | `/tasks/:id/relayed`  | mark shown to human (idempotent)                      |

Unknown routes return `404` JSON, wrong methods `405`, malformed JSON bodies `400`. The server
never crashes on bad input.

---

## Data & git

Queue contents live in **`data/events.jsonl`** — one JSON event per line, append-only:

```
{"t":"create","task":{...}}
{"t":"patch","id":"msjfwakm-pgrjbw","patch":{"status":"claimed",...}}
```

`data/` is **gitignored** and must stay that way — it holds real task text. Only code and docs are
committed. To wipe the queue, stop the service, delete `data/events.jsonl`, start it again.

On boot the log is replayed and a torn final line (from a hard kill mid-write) is skipped rather
than fatal; the startup log reports `N events replayed, M skipped`.

The log grows forever. This is intentional — it is the durability mechanism and the volumes here
are tiny. If it ever gets unwieldy, archive the file and restart.
