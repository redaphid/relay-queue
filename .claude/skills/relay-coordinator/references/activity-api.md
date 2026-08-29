# Activity reporting API - `spawned` / `finished` rows

Read when: you are about to POST `/activity`. The naming rule that binds you
whether or not you read this file stays in the core manual under
**Activity reporting - naming subagents**.

```sh
curl -X POST http://127.0.0.1:3901/conversations/<id>/activity -H 'content-type: application/json' \
  -d '{"agent":"me","kind":"spawned","subagent":"agent-foo","task":"..."}'
  # and when it returns:
  -d '{"agent":"me","kind":"finished","subagent":"agent-foo","ok":true}'
```

- `kind`: `spawned` | `finished` | `tool` | `note`. Only the parent posts `spawned`/`finished`, exactly once each — a worker never announces itself (a stray self-`spawned` overwrites its own row and can resurrect a finished worker as `running:true`, `nameCollision:true`).
- `spawned` and `finished` pair on the subagent NAME. Post `spawned` at actual spawn time — a backfilled roster carries backfill timestamps, not true start times.

---

Back to the core manual: `SKILL.md`.
