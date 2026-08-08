# Give the page an HTTPS origin (Cloudflare Tunnel + Access)

**Labels:** `infra`, `security`, `blocked-on-credentials`

## Why

Two problems, one fix.

1. **The microphone does not work off this machine.** Browsers only hand `getUserMedia` to a
   [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). The page
   is reached over plain `http://` on a LAN/tunnel IP today, so on a phone the mic button cannot
   work at all — which is exactly the device the dictation feature was built for. The page already
   detects this and says so rather than failing silently, but that is a message, not a fix.
2. **The queue is currently open on the LAN.** `docker-compose.yml` publishes `3901` on all
   interfaces with no auth, so anyone on the network can read and post real messages.

An HTTPS hostname in front of it solves both: secure context for the mic, and a place to attach
authentication.

## What to do

Use the **Cloudflare Tunnel** already running on this machine (the `cloudflared` container), the
same pattern as the existing `soul` exposure. **Do not use Tailscale** — it was evaluated and
rejected; `tailscale serve` is also disabled at the tailnet level here.

The tunnel is **token-managed**, so its routing lives in the Cloudflare Zero Trust dashboard, not in
a local config file. Nothing about this belongs in the repo — no token, no hostname secrets.

1. In **Zero Trust → Networks → Tunnels**, add a public hostname to the existing tunnel:
   - hostname: `relay.hypnodroid.com`
   - service: `http://host.docker.internal:3901`
     (`cloudflared` is a container; it cannot reach the host on `127.0.0.1`. Use the host alias, or
     put `cloudflared` and `relay-queue` on a shared docker network and use `http://relay-queue:3901`.)
2. Put an **Access application** in front of that hostname so it is not open to the internet.
3. Confirm the DNS record Cloudflare creates resolves and serves the page over `https://`.

## Watch out for

- **SSE must not be buffered.** The thread now streams over `GET /events`. The server already sends
  `x-accel-buffering: no` and a comment heartbeat every 25 s, which is inside the ~100 s idle
  timeout proxies typically use. Verify events still arrive promptly through the tunnel rather than
  in batches — this is the most likely thing to break.
- **Access session expiry vs. EventSource.** When an Access session lapses, the stream will start
  getting redirected to a login page instead of events. The page falls back to polling and shows
  `offline — retrying`, so it degrades safely, but check what the recovery actually looks like.
- **`POST /stt` uploads up to 8 MiB.** Make sure the tunnel/Access config does not cap request
  bodies below that, and that a ~2-3 s utterance round-trips in about a second.
- **Nothing in the page needs changing.** Every request it makes is root-relative and same-origin
  (`connect-src 'self'`), so it works behind any path-preserving proxy unmodified. Keep it that way.

## Meanwhile

`http://localhost:3901` **is** a secure context. Dictation can be developed and tested today in a
desktop browser on the machine itself — just not from the phone.

## Acceptance criteria

- [ ] `https://relay.hypnodroid.com` serves the UI and is gated by Cloudflare Access.
- [ ] The mic button works on a phone at that URL: tap, speak, stop talking, message sends.
- [ ] A message posted on one device appears on another within ~1 s (SSE is not being buffered).
- [ ] `POST /stt` round-trips an 8 MiB body without being truncated or rejected.
- [ ] The setup survives a reboot (tunnel config is server-side; `cloudflared` is `restart: unless-stopped`).
- [ ] No token, hostname secret or credential is committed to the repo.
- [ ] Follow-up decided: whether to stop publishing `3901` on all interfaces once the tunnel is the
      way in (see `authenticate-the-queue.md`).

## Status

**Blocked on credentials only the user has** — this needs a Cloudflare dashboard login. Everything
on the application side is already done.
