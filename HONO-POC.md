# Hono + OpenAPI + generated-CLI proof-of-concept

Scope: **5 routes, mounted under `/v2`, running alongside the existing raw-`node:http`
server untouched.** This is not a migration and does not touch any of the ~40 existing
routes in `server.js`. It answers one question: can this codebase get a spec-generated
OpenAPI doc and a working CLI out of its own route definitions, without hand-maintaining
either — and if so, is continuing worth it.

## What's here

- `POST /v2/tasks/:id/claim`
- `POST /v2/tasks/:id/result`
- `POST /v2/tasks/:id/relayed`
- `POST /v2/tasks/:id/progress`
- `GET  /v2/tasks` (filtered by `conversation`/`status`)
- `GET  /v2/openapi.json` — the OpenAPI 3.0 document generated from the route definitions above
- `GET  /v2/docs` — Swagger UI over that document
- `GET  /v2` — a one-line discovery pointer to the above

All of it lives in `server.js`, in one clearly delimited section between `relayTask()`
and the router (search for `v2 (Hono + OpenAPI proof-of-concept)`). Nothing was extracted
into new files, on purpose — the whole POC is one diff-reviewable, one-command-revertable
block.

## Packages chosen, and why

| Package | Role | Why this one |
|---|---|---|
| `hono` | web framework | The one asked for. Fast, small, framework-agnostic router built on the Fetch API. |
| `@hono/zod-openapi` | route definition + validation + doc generation | Official Hono-team package (not the third-party `hono-openapi`). Define a route once with `createRoute({ request, responses })` using Zod schemas, get both request validation and the OpenAPI document from that single definition — no separate spec to keep in sync. Actively maintained (published within the week at time of writing). |
| `@hono/node-server` | bridge Hono's Fetch-based app into `node:http` | Hono apps are `(Request) => Response`; this project's server is a raw `http.createServer` callback. `getRequestListener(app.fetch)` returns exactly a `(req, res)` Node handler, which is what let `/v2` get mounted as one `if` branch in the existing dispatcher rather than a second server/port. |
| `@hono/swagger-ui` | interactive doc viewer | Cheap, official, makes "does the doc look sane" a thing you can actually look at rather than just eyeball as raw JSON. |
| `zod` | schema library | Peer dependency of `@hono/zod-openapi`. |
| `openapi-to-cli` (`ocli`) | OpenAPI → CLI | See below. |

### The CLI generator decision

Options considered and why they were ruled out:

- **OpenAPI Generator** (`openapi-generator-cli` / `@openapitools/openapi-generator-cli`) is the
  best-known, most broadly maintained tool in this space (it can emit a `bash` client that scaffolds
  actual CLI subcommands). Ruled out for this box specifically: it wraps a Java JAR, and **this
  machine has no `java` on PATH.** That's an environment fact, not a judgment on the tool.
- `swagger-cli`, `swagger-codegen-cli`, `restish` — all real, all last published in 2022 or earlier.
  Not actively maintained.
- `api` (readme.com) generates a Node SDK you `require()` and call as functions — not a terminal CLI.

**Chosen: `openapi-to-cli` (bin: `ocli`).** Published 13 versions since March 2026, most recent
2 days before this was written, ~790 downloads/month. It's a small single-maintainer project (worth
knowing, not disqualifying for a POC) that does exactly the asked-for thing: point it at a base URL
and an OpenAPI document, and it turns every operation into a runnable subcommand *at request time* —
no separate codegen/build step, no generated package to vendor. `ocli commands` lists what's
available; `ocli <operationId> --flag value` runs it. Flags are derived straight from each
operation's declared parameters and request body schema, which is exactly why the request-body
schemas in `/v2/openapi.json` had to be right (see the gotcha below) rather than merely present.

## The migration technique, and why it's not a rewrite

The 5 Hono routes do **not** reimplement `claimTask`, `resultTask`, `progressTask`, `relayTask`, or
`applyFilters`. Each Hono handler validates/documents the request, then calls the *same* function the
v1 route calls, through a small `res` shim that records what would have been written to a real
`http.ServerResponse`:

```js
function v2ShimRes() { /* .writeHead(code), .end(body) -> captured, not sent */ }
async function v2DispatchLegacy(c, id, fn) {
  const body = await v2ReadBody(c);       // same parsing readBody() uses
  const shim = v2ShimRes();
  fn(shim, id, body);                     // the ORIGINAL handler, unmodified
  return v2LegacyResponse(shim);          // shim's output -> a Fetch Response
}
```

This was a deliberate choice over "carefully reimplement the same checks," and it's the reason the
parity testing below could be this confident: the mutation logic isn't duplicated, so it cannot
drift between v1 and v2. A real migration would do this same wrap-first step for every route, then
inline each handler's body into its Hono route and delete the shim call **one route at a time**,
each inlining independently reviewable and revertable. That staged path — wrap, verify, inline,
repeat — is the concrete answer to "how would you migrate the rest," not a rewrite.

## The one real gotcha this surfaced

`@hono/zod-openapi`'s automatic body validator treats a **genuinely empty request body as
malformed JSON** — confirmed by direct test, and true even when the schema marks the body
`required: false`. That's a real behavioral difference from this project's own `readBody()`, which
treats an empty body as `{}` on purpose.

This isn't cosmetic here: `POST /tasks/:id/claim` with no body at all, and `POST
/tasks/:id/progress` with no body ("a bare POST is a valid 'still here'", per `COORDINATOR.md`) are
both load-bearing, documented behaviors of this exact queue. Wiring the declared Zod body schemas
into Hono's own validator would have silently broken both.

**What this POC does instead:** these 3 routes parse their own body with `parseBodyBuffer()` — a
function pulled out of the existing `readBody()` verbatim (same UTF-8 strictness, same
empty-is-`{}`, same "malformed JSON body" message) specifically so v2 can't drift from v1 on this.
The Zod body schemas still exist and still appear in `/v2/openapi.json` — they're patched into the
generated document by hand (`v2InjectRequestBodies`) for documentation and CLI-flag generation, but
are never used to gate a request at runtime. Verified directly, not assumed: empty-body claim and
empty-body progress return identical 200s with identical bodies on `/tasks/*` and `/v2/tasks/*`.

## Verified equivalence

Tested locally against a scratch instance (`PORT=0`, scratch `DATA_DIR`, `RELAY_BOOT_NONCE` echoed
on `/health` to confirm the responding process was the one just spawned — never against the live
container on 3901). Same request, both routes, compared side by side:

| Case | v1 | v2 |
|---|---|---|
| claim, empty body | 200, `claimedBy: null` | 200, `claimedBy: null` — identical |
| claim on a done task | 409 `"task is already done"` | identical |
| result, missing `result` key | 400 `"result is required"` | identical |
| result, `{"result": null}` | 400 `"result is null: a null answer is not an answer..."` | identical |
| result, malformed JSON body | 400 `"malformed JSON body"` | identical |
| progress, bare POST (no body) | 200, `note: null`, lease renewed | identical |
| progress, after the task is done | 409 `"task is already answered..."` | identical |
| relayed, then re-claim | 409 `"task is already done"` | identical |
| list `?status=bogus` | 400 `"invalid status \"bogus\""` | identical |
| list `?status=done` | correct count | same count |

## The CLI, actually run

```
$ npx ocli profiles add relay-poc --api-base-url http://127.0.0.1:<port> --openapi-spec http://127.0.0.1:<port>/v2/openapi.json
$ npx ocli use relay-poc
$ npx ocli commands
  v2_tasks              List tasks
  v2_tasks_id_claim     Claim a task
  v2_tasks_id_result    Post a result, closing the task
  v2_tasks_id_relayed   Mark a task's result as delivered
  v2_tasks_id_progress  Post a progress note without closing the task

$ npx ocli v2_tasks_id_claim --id <taskId> --by cli-poc-agent      # -> claimed task JSON
$ npx ocli v2_tasks_id_progress --id <taskId> --note "cli says hi" # -> progress ack
$ npx ocli v2_tasks_id_result --id <taskId> --result "done via cli" # -> done task JSON
$ npx ocli v2_tasks_id_relayed --id <taskId>                       # -> relayed:true
$ npx ocli v2_tasks --status done                                  # -> filtered list
```

Ran the full claim → progress → result → relayed → list lifecycle through the generated CLI against
a scratch instance; every step produced the correct state transition.

## What migrating the rest would actually cost

`server.js` is ~6,200 lines with roughly 40 routes, a lot of them carrying real subtlety documented
inline (the UTF-8 strictness in `readBody`, the lease/takeover logic in `claimTask`, the
checklist/picks event-sourcing, push notifications, SSE streams, the self-restart-on-file-change
mechanism, `share.js`). None of that is Hono's problem to solve — it's this application's accumulated
correctness, and it would all have to survive the move.

Cost, in order of how much of it this POC actually exercised:

1. **The wrap-and-shim step for the other ~35 routes** is mechanical and low-risk — same pattern as
   the 5 here, route by route. This is genuinely cheap and could be done incrementally without
   freezing other work on the file.
2. **Every route needs the same "does Hono's own validation change behavior" audit** this POC did for
   bodies. The empty-body finding above was not obvious in advance and would not have been caught
   by reading the Hono docs — it took writing a probe script against the actual library. Multiply
   that by every route with a body, a query filter, or an unusual status code, and it is the
   dominant cost of a real migration, not the routing itself.
3. **SSE (`/stream`) and the push (`web-push`) endpoints** are not simple request/response and don't
   fit `createRoute`'s response-schema model cleanly; they'd need to stay as plain Hono routes (no
   OpenAPI doc for them) or be left on v1 permanently.
4. **The self-restart-on-source-change mechanism** (`watchSelf()`) and the `require.main` boot guard
   are unrelated to Hono but would need re-verifying after any structural change this size, since
   they're timing-sensitive and this file **is** the deployment.
5. **The CLI's usefulness scales with the spec's honesty.** `ocli` generates flags straight from
   whatever schema is in `/v2/openapi.json` — a full-server migration is also implicitly a project to
   make every route's request/response shape precise enough to be worth generating a CLI from, which
   today many of the hand-written `fail()` responses are not (ad hoc `extra` fields, inconsistent
   shapes across similar errors).

None of this is a reason not to do it. It's a reason it's a multi-session project with its own
audit step per route, not a mechanical find-and-replace.

## Recommendation

**Worth continuing, but as a slow background migration — wrap-and-verify one route at a time behind
`/v2`, never a cutover — not as a dedicated rewrite.** The pattern proved out cleanly (a real,
generated OpenAPI doc; a real, generated, working CLI; zero behavioral drift on the 5 routes
tested), and the wrap-first technique means each step is small and independently revertable. The
actual cost center is the per-route validation-behavior audit, not the framework, so the honest
plan is: migrate a route only when someone is already touching it, verify it the way this POC did,
and let `/v2` grow until it can replace `/v1` outright rather than committing to a deadline for that
now.
