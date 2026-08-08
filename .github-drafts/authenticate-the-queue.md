# The queue is open on the LAN — put auth in front of it

**Labels:** `security`, `infra`
**Related:** `https-for-mic-access.md`

## The problem

`docker-compose.yml` publishes port `3901` on **all interfaces**:

```yaml
ports:
  - "3901:3901"     # was 127.0.0.1:3901:3901
```

There is no authentication anywhere in `server.js`. So **anyone on this LAN or Tailnet can read
every message in the queue and post new ones.** `data/events.jsonl` holds real private
conversations between the user and their agents, and the API allows posting tasks that agents will
then act on. That second part is the sharper edge: this is not just a data-disclosure issue, it is
an untrusted-input path into an agent loop.

The compose comment acknowledges this ("The page has no auth yet — anyone on those networks can
read/post"), which makes it a known-and-accepted risk rather than an oversight — but it should not
stay accepted indefinitely.

## Options

1. **Front it with Cloudflare Access and stop publishing the port publicly.** Cheapest and most
   consistent with the rest of this machine; it is the same work as
   [`https-for-mic-access.md`](https-for-mic-access.md), just finished properly. Revert the port
   mapping to `127.0.0.1:3901:3901` and let `cloudflared` reach it over a shared docker network.
   Preferred.
2. **A bearer token in `server.js`.** Kept out of git via `.env`, checked on every route. Simple,
   but adds a secret to manage and means the page has to hold it — which the page currently and
   deliberately does not do ("contains no secrets").
3. **Bind to the Tailscale interface only.** Narrows the audience to the tailnet rather than
   removing the problem. Rejected as a primary answer; the user does not want Tailscale in this
   path.

Option 1 also keeps `server.js` free of auth code entirely, which is worth something for a file
whose whole selling point is that it is small and has no dependencies.

## Acceptance criteria

- [ ] The queue is not reachable unauthenticated from another machine on the LAN.
- [ ] `curl http://<lan-ip>:3901/thread` from another device fails.
- [ ] The authenticated path still works from the phone, including SSE and `/stt`.
- [ ] No secret is committed to the repo.
- [ ] `docker-compose.yml`'s comment updated to describe what is actually true afterwards.
- [ ] README's exposure warning updated or removed.
