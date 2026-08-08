# Off-machine scheduler: post a cron, get a callback

**Status:** design note, captured 2026-08-08. Not built. Deliberately deferred —
raised the night before a 9am flight.

## The idea

A Cloudflare endpoint this machine can POST a cron expression to, wrapped as an
MCP tool, which then calls back here when it fires. A durable timer that lives
off this machine.

## What actually implements it

**Not Workers cron triggers.** Those are declared statically in `wrangler.toml`
and applied at deploy time — you cannot POST a new one at runtime. This is the
part most likely to be misremembered.

**Durable Object Alarms** are the mechanism. One DO instance per scheduled job,
`storage.setAlarm(timestamp)`, which is set programmatically, persists, and
survives eviction and restarts. For a recurring cron, the alarm handler computes
the next occurrence and re-arms itself. Cloudflare Workflows and Queues (delayed
messages) are alternatives with different durability/retry trade-offs.

*Confidence: high on cron triggers being static, high on DO alarms being the
programmatic path. Verify current API shapes against live docs before building —
this area moves, and `McpAgent` was already found deprecated the same night.*

## The hard part is not scheduling — it is the callback

Getting from Cloudflare back into this machine means one of:

1. **Through Access** — requires a service token, i.e. a credential that can post
   into the relay from the internet. That is a real security decision, not an
   implementation detail, and needs an explicit ask.
2. **Machine-initiated** — this machine holds a connection open or polls. But
   that reintroduces a local always-on process, which we already have in
   `relay-watchdog`. If the local process is the thing that survives, the Worker
   adds nothing.

So the Worker's *only* unique value is **surviving this machine being dead or
offline** — noticing "the house has gone silent" from outside. That is a real
and different problem from the one `relay-watchdog` solves, and worth building
for that reason alone. It is not a replacement for the watchdog.

## The wall it does not break

**Nothing off-machine can make an idle Claude session take a turn.** A remote
timer can fire, speak through the Echo, and change the lights — all reaching the
*human*. It cannot rouse an agent. Waking an agent requires an on-machine
spawner, which is the risk class deliberately avoided so far. Any design here
should be judged on whether it reaches the human, not on whether it "restarts
the agent" — it cannot.

## Prior art in this repo

See the settled Cloudflare findings in `WORK-LOG.md`: Workers cannot spawn
processes (`node:child_process` is a stub), `wrangler` has no `mcp` subcommand,
and `createMcpHandler` is the current API while `McpAgent` is deprecated.
