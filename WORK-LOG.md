# Work log — agent system

Durable state for the relay/agent work, so a dead session loses momentum but not
knowledge. Update this when something lands, unblocks, or turns out to be wrong.
Last updated 2026-08-08, ~03:45.

## Blocked on the human

| # | Thing | Why it needs you | Exact action |
|---|---|---|---|
| 1 | Publish `relay-queue` to GitHub | `gh` works on this machine; the agent sandbox refuses `gh repo create` / `gh issue create` | `cd /d/projects/relay-queue && gh repo create relay-queue --public --source . --remote origin --push` — or add a Bash permission rule for `gh` and an agent does everything, including filing the 8 drafts |
| 2 | Deploy mindmeld image | Ships 3 server-side bug fixes, but also 4 undeployed commits (1.20.0 → 1.21.0+), one touching the same ingestion path | Bump `package.json`, push to main, CI tags + publishes, then `docker compose pull && docker compose up -d` |
| 3 | GPU gate cooldown | Changes a deliberate GPU-protection policy | `GATE_COOLDOWN` 900 → ~180 in `D:\projects\ollama-proxy\supervise.ps1` (not currently exposed there) |

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

## Open, not blocked — next work

1. Fix conversation-mode endpointing: it cuts mid-sentence (1.2 s is shorter
   than a thinking pause). Longer window + stitch back-to-back fragments.
2. Multi-conversation UI: hamburger menu, conversation list, switching.
3. Stats page — really a *liveness* page: is an agent watching, how fast are
   replies, what is the oldest unanswered message. Needs a `POST /heartbeat`
   the main session pings.
4. Speak-aloud MCP so Claude can talk through the Alexa. Docker on Windows has
   no audio passthrough, so playback must be host-side; the Home Assistant route
   (piper is already wired there) may avoid the problem entirely.

## Traps — do not rediscover these

- **`localhost` vs `127.0.0.1` in tunnel rules.** cloudflared resolves `localhost`
  to `::1` first. Bit the metamcp rule, then bit relay.
- **relay-queue cannot be bound to loopback.** cloudflared runs `network_mode:
  host`; on Docker Desktop that host is the WSL2 VM, which cannot reach a port
  published on *Windows'* loopback. Two outages taught this. Close the LAN hole
  in the app, not the network.
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
