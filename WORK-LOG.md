# Work log — agent system

## Restarting after a reboot or a dead session — read this first

**Everything durable survives on its own.** Docker containers all carry
`restart: unless-stopped`, so relay-queue, vikunja, mindmeld, the mcp-hub, and
the Cloudflare tunnel come back with the machine. The queue's message history is
an append-only log on disk and replays on boot. `speak-mcp` returns via its
Scheduled Task. The public endpoints (`relay.hypnodroid.com`,
`mcp.hypnodroid.com/mcp`) keep working without anyone present.

**What dies is the agents, and only the agents.** No coordinator survives a
session ending. Nothing on disk is lost when they do — that is the whole point
of this file.

To come back, open Claude Code in `D:\projects` and say roughly:

> Read D:\projects\relay-queue\WORK-LOG.md and COORDINATOR.md. You are the
> Communicator (Zora) — own the `main` conversation on the relay queue at
> http://127.0.0.1:3901, answer my messages there, and poke any other
> conversation's coordinator when it has pending work.

That is sufficient. Auto-memory loads on its own and carries the traps and
decisions; this file carries the state. Then, if wanted, spawn a coordinator per
non-`main` conversation using `COORDINATOR.md` as its brief.

**Check it came back** with `GET /status`: agents should appear with fresh
`last acted` times. If every agent is stale while messages sit pending, nothing
is listening — that is the signal to restart the session.


Durable state for the relay/agent work, so a dead session loses momentum but not
knowledge. Update this when something lands, unblocks, or turns out to be wrong.
Last updated 2026-08-08, ~03:45.

## Decided — do not re-raise

**LAN exposure is accepted.** relay-queue (:3901), hue (:3100), nanoleaf, and
spotify all publish on `0.0.0.0` with no authentication. The user decided
2026-08-08: *"fine with them being exposed to the LAN. I live alone. We'll fix
it at some point."* That is a deliberate risk acceptance, not an oversight —
stop flagging it. `authenticate-the-queue.md` stays as a draft for when they
want it.

One nuance recorded once, not to be repeated: "LAN" here includes Tailscale, so
the surface is every device on the tailnet, not only the house. The public
hostnames (`relay.`, `hue.`, `metamcp.`, `mindmeld.`) are all correctly gated
behind Cloudflare Access — verified.

## Blocked on the human

| # | Thing | Why it needs you | Exact action |
|---|---|---|---|
| 1 | Publish `relay-queue` to GitHub | `gh` works on this machine; the agent sandbox refuses `gh repo create` / `gh issue create` | `cd /d/projects/relay-queue && gh repo create relay-queue --public --source . --remote origin --push` — or add a Bash permission rule for `gh` and an agent does everything, including filing the 8 drafts |
| 2 | Deploy mindmeld image | Ships 3 server-side bug fixes, but also 4 undeployed commits (1.20.0 → 1.21.0+), one touching the same ingestion path | Bump `package.json`, push to main, CI tags + publishes, then `docker compose pull && docker compose up -d` |
| 3 | GPU gate cooldown | Changes a deliberate GPU-protection policy | `GATE_COOLDOWN` 900 → ~180 in `D:\projects\ollama-proxy\supervise.ps1` (not currently exposed there) |
| 4 | **Mint a Vikunja API token with `delete` + `relations` permission** | The current token is scoped without them; both return `401` reproducibly with plain `curl`, so no code change can fix it | Vikunja web UI → Settings → API Tokens. Note Vikunja **forces an expiry** on API tokens, so the existing one will 401 across the board eventually — worth a calendar note |

*(Was the old #4: "start the watchdog by hand" — resolved 2026-08-08 by containerizing it.
The user's suggestion, and the better design: `restart: unless-stopped` makes it
outlive agents, sessions, and reboots, so nobody has to remember.)*

## Issue drafts, written and unpublished

In `.github-drafts/`, each self-contained with acceptance criteria.
`PUBLISH.md` holds the exact `gh issue create` commands.

- `authenticate-the-queue.md` — **highest value.** The queue has no login; it is
  published on all interfaces, and a post here makes agents act. This is also
  the prerequisite for Claude Code via the coordinator.
- `two-way-voice-conversation.md`, `hands-free-voice-input.md`
- `make-ui-a-pwa.md`, `https-for-mic-access.md`
- `headphone-push-to-talk.md`, `wake-word-hands-free.md` (openwakeword already
  runs on :10400)

## Shipped and verified

- **relay-queue**: voice dictation (whisper `tiny-int8` on :10300 via a hand-rolled
  Wyoming client in `server.js`), SSE live updates, Enter-to-send, desktop-only
  autofocus, self-updating deploy, conversation mode + spoken replies (piper
  :10200), multi-conversation data model (`conversationId`).
- **Exposed** at `https://relay.hypnodroid.com` behind Cloudflare Access — this
  is what unblocked phone microphone access.
- **MCP**: `https://mcp.hypnodroid.com/mcp` serves all 34 hub tools (mindmeld,
  spotify, nanoleaf). Worker version `a0cadeae-…`. MetaMCP local auth removed by
  design; Access is the only remote gate.
- **Vikunja** v2.5.0 on :3456, syncing into mindmeld as `dataClass: notes`.
- **mindmeld**: truthful status chip + force-start button live (frontend is
  bind-mounted, no rebuild needed).
- **GPU gate cooldown 900s → 180s** (2026-08-08, verified live: `/_gate` on
  :11436 reports `required_quiet_seconds: 180`). This was the real cause of
  mindmeld "stalling" — the gate waits for *continuous* quiet, and on a machine
  where ComfyUI and ollama share the GPU, any desktop blip reset the counter, so
  15 minutes of unbroken silence effectively never arrived. Set in two places so
  they cannot drift: `proxy.py:42` default and a `-GateCooldownSec` param in
  `supervise.ps1`. `D:\projects\ollama-proxy` is **not a git repo** — rollback is
  the `.bak` files beside each source, then kill the listener on 11436 and let
  the supervisor relaunch. Note the in-memory supervisor is still the old copy
  until the next logon; harmless, since `proxy.py`'s default supplies 180 anyway.

## Known bug — `/status` headline (found 2026-08-08 05:22, unowned)

The headline cries wolf and blames the wrong agent:

> "Zora-watcher is still checking in but has done nothing for 2 min, with 1
> message being worked on. It looks stuck."

Nothing was stuck — the claimed message was Romeo's and Romeo was mid-task.

1. **Wrong agent.** It attributes the claimed message to whichever agent the
   `watch` block selected, not to the one that actually claimed it. The claim
   record has a `who`; use it.
2. **Working reads as broken.** A task claimed 2 min ago by a working agent is
   the healthy path. This is the inverse of the idle-vs-broken rule and is more
   corrosive: a page that cries wolf gets ignored right before the once it is
   right. Escalate only well past the median answer time (median 180 s, worst
   11645 s), and name the claiming agent.
3. `Zora-watcher` is a shell loop, not an agent — exclude it from
   stuck-attribution; by construction it never answers anything.
4. Notes render raw: `holds: D:\projects\vikunja-mcp` came out with a literal
   vertical tab, because `\v` is being interpreted between POST and render.
   JSON-encode the note.

## Open, not blocked — next work

*(Rewritten 2026-08-08 08:15. The previous four items — endpointing,
multi-conversation UI, liveness page, speak-aloud MCP — had all shipped hours
earlier and the list was still advertising them as open. A stale to-do list is
the same failure as a stale memory: it sends the next agent to redo finished
work. Prune this section when you finish something, not later.)*

1. Fold config-page assertions into `tools/mobile-selftest.js`. The page at
   `public/index.html:521-530` (`#statusview` / `#statusopen`) has **zero**
   coverage. Ten checks were written and passed against a throwaway copy of the
   harness outside the repo, so the work is mostly done — it just needs merging
   once the config agent is out of that file. Serialize; do not open it early.
2. Second viewport in the selftest. It only drives 390×844, so a break at any
   other phone width passes silently — which is the exact failure mode the
   suite was built to catch.

## Reusable capabilities worth knowing

- **Anything can speak aloud, with no MCP and no Claude session.**
  `POST http://127.0.0.1:12020/speak` `{"text":"..."}` — plain unauthenticated
  HTTP on loopback, renders through wyoming-piper, plays on the **Echo Studio**
  (not the Windows default device). `GET /health` reports bluetooth/device
  state. Verified end to end 2026-08-08. This is the answer to "how does an
  outside process reach the human when no page is open," and it needs zero new
  infrastructure. **Reserve it for what matters** — completions, blockers,
  failures, anything needing the user's hands. Never status or progress; they
  asked for that specifically after it was over-used. Write for the ear (expand
  paths phonetically), a sentence or two; ~40 words is ~13 s of playback.

- **`relay-watchdog`** (`D:\projects\relay-watchdog`, own repo, unpushed):
  **running as a container with `restart: unless-stopped`** — so it survives
  agent death, session death, and reboot, and nobody has to start it. Reaches
  relay-queue by service name on the external `relay-queue_default` network (no
  published port), and speak-mcp via `host.docker.internal:12020`. Alarms repeat
  with doubling backoff (10m → 20m → 40m, capped at 1h), resetting when the
  queue drains. **Grep `ALARM WAS NOT SPOKEN`** — inside the container there is
  no Windows speech fallback, so that string is the *only* signal that an alarm
  fired silently. Still runnable standalone as `uv run watchdog.py`.
  Watches for unanswered *and* stuck (claimed-never-answered) work, judges
  liveness on whether an agent **acted** rather than on heartbeats, and measures
  age from each message's own timestamp so a queue restart cannot reset the
  clock. It deliberately never writes to the queue — an alarm posted as a
  message would become unanswered work and feed the alarm. It watches `main`
  too, on purpose: if `main` goes unanswered, the router is dead.

## Settled question — Cloudflare and stdio MCP servers (verified 2026-08-08)

**No Cloudflare CLI wraps an existing stdio MCP server as a remote one.** It only
scaffolds a *new* TypeScript server on Workers. This is structural, not a gap:
`node:child_process` is a non-functional stub in the Workers runtime (as are
`cluster` and `worker_threads`), so a Worker cannot spawn a process, so
`vikunja-mcp` can never run there. `wrangler` 4.120.0 has no `mcp` subcommand.

- `mcp-remote` is third-party (not Cloudflare) and bridges remote→stdio for
  *clients* — the opposite direction from what we need.
- `createMcpHandler` is the current API. `McpAgent` is **deprecated and
  feature-frozen**, and the official C3 templates still scaffold onto it — do
  not start there.
- `workers-mcp` is dead (v0.0.13, Dec 2024) and exposes your Worker's own
  methods; it is not a stdio host.

**Decision: keep `vikunja-mcp` as a real Node process here and expose it through
the existing Tunnel + Access pattern, same as mindmeld.** No rewrite. (The
alternative — reimplementing the tools on `createMcpHandler` against Vikunja's
REST API — is only worth it if edge hosting becomes the goal; Workers VPC would
then let it reach `localhost:3456` without public exposure.)

## Hue API traps (all verified live 2026-08-08, not read from docs)

- **`"amber"` is rejected `400`.** It is not a CSS colour. Use `"orange"`
  (`202`). This one nearly shipped twice — the departure brief names amber as
  its come-back colour, and both nudger implementations used it. **Check the
  status code on every colour call**; a rejected colour changes nothing and
  reports nothing.
- **`PUT /api/lights/{id}/state` with `hue`/`saturation` silently does nothing**
  — returns `202 Light state updated` and no light moves. Use `/color` with a
  CSS string. Still unfixed; the agent assigned was stopped.
- **Brightness is `0`–`1` on write** (`254` returns a `400`), but `GET
  /api/lights` reports it back as `0`–`254`.
- **The `hue`/`saturation` readback is stale** for lights in `colorMode: "xy"`,
  so it cannot confirm a colour landed. Judge by the light, not the API.
- Working routes: `/api/all/{color,on,off}`,
  `/api/lights/{id}/{color,color-temp,brightness,on,off,state}`, same for
  `/api/rooms/{id}`, plus `/api/scenes/{id}/activate`. Spec:
  <http://127.0.0.1:3100/docs>.

## Traps — do not rediscover these

- **An agent cannot start a conversation. It can only answer one.** `createTask`
  sets `role` itself (`server.js:1566` — *"server-set, never taken from the
  client"*), so every `POST /tasks` is a **user** message no matter what `role`
  you send, and there is no delete route. An unprompted status update therefore
  lands in the thread looking like the human said it, sitting `pending`, and — if
  you watch your own conversation — trips your own monitor. I did this at
  08:05 on 2026-08-08 and had to claim and answer my own message to clear it.
  To speak unprompted you must post a task and then immediately answer it;
  accept that both halves show. Cross-agent handoffs (routing work to another
  session's conversation) are the legitimate use of `POST /tasks` — a task
  addressed *to* an agent is genuinely a request, so the `user` role fits.

- **`localhost` vs `127.0.0.1` in tunnel rules.** cloudflared resolves `localhost`
  to `::1` first. Bit the metamcp rule, then bit relay.
- **relay-queue cannot be bound to loopback.** cloudflared runs `network_mode:
  host`; on Docker Desktop that host is the WSL2 VM, which cannot reach a port
  published on *Windows'* loopback. Two outages taught this. Close the LAN hole
  in the app, not the network.

- **Do not over-generalize the above.** A *normal bridge-network* container
  **can** reach a Windows host process bound to `127.0.0.1` — `host.docker
  .internal` works, proven 2026-08-08 by playing a real alarm on the Echo from
  inside the watchdog container, against `127.0.0.1:12020`. The two facts
  coexist: Docker Desktop's proxy forwards `host.docker.internal` to the Windows
  host including its loopback, whereas `network_mode: host` opts out of that
  bridge entirely and lands in the WSL2 VM's namespace, where no such proxy
  exists. **Rule: `network_mode: host` is the problem, not loopback itself.**
  Test the specific path; do not reason from the cloudflared case.
- **mindmeld stalls are usually the GPU gate**, not mindmeld: it needs 900 s of
  *continuous* quiet, and any desktop app blipping over 10% resets the counter.
  `GET http://127.0.0.1:11436/_gate` tells you the truth.
- **wrangler credentials** live at `%APPDATA%\xdg.config\.wrangler\`, not
  `~/.wrangler` — checking the usual path wrongly says "not authenticated".
- **`mcp.hypnodroid.com` is a Worker** (`D:\projects\mind-meld\mcp-gateway`), not
  this stack. It exists because bare Access breaks claude.ai connector
  registration.
- **mind-meld is a public repo** with a mechanically enforced no-personal-data
  check. Real hostnames go in gitignored files only. Its tilde-path rule had a
  false positive on `~${…}` template literals; fixed with regression tests.
