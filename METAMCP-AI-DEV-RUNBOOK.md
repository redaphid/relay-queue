# Switch MetaMCP to the upstream `ai-dev` branch

> **SUPERSEDED 2026-09-02 — do not run this.** Aaron chose the community fork
> instead ("Let's use the community fork"). Use
> **`METAMCP-FORK-RUNBOOK.md`**, which needs no source build at all: the fork
> auto-publishes `ghcr.io/umbrella-it-group/metamcp:latest` to ghcr.
> Kept only as the record of why a build was needed for upstream `ai-dev`.

**Status:** approved by Aaron 2026-09-02 ("Go. Just do it" / "Yolo") in relay tab
`mtjnrt3o-mdswsl`. **Not executed** — the auto-mode classifier blocks an
auto-seated coordinator from dispatching a `docker build`. Run this from an
interactive session, or paste it into a shell.

## Why a build is needed at all

`ai-dev` is the **default branch** of `github.com/metatool-ai/metamcp`. Its
README says so deliberately:

> This ai-dev branch will be the forward onging dev branch which contains ai
> agent changes. **Please test before you build the image based on this branch.**

There is **no `ai-dev` tag on ghcr**. Published tags are semver (…`2.4.20`,
`2.4.21`, `2.4.22`) plus `latest`, `2`, `test`, `2-test`, `v2.4.1-test`,
`v2.4.2-test`. So `METAMCP_VERSION` cannot reach `ai-dev` — it has to be built.

Currently running: `ghcr.io/metatool-ai/metamcp:2.4.22`, released **2025-12-19**.
`ai-dev` HEAD is `ff4ff2de9d25453c52dcc7be32680b30700a6012`, **2026-06-22** —
about six months of unreleased work.

## The design: tag into the same namespace

`D:\tools\Projects\mcp-hub\docker-compose.yml` already reads:

```yaml
image: ghcr.io/metatool-ai/metamcp:${METAMCP_VERSION:-2.4.22}
```

So build locally and **tag into that same namespace**. The compose file is never
edited, and rollback stays a one-line `.env` change.

**Do not** replace `image:` with a `build:` context. It is the obvious move and
it destroys the rollback knob.

## Run it

```sh
cd /mnt/d/tools/Projects/mcp-hub

# 0. pre-flight. The repo is local-only (no remotes, branch master) and was
#    dirty: scripts/configure.mjs, scripts/hub-tools.mjs, upstreams.json
#    modified, upstreams.json.bak untracked. Leave those alone.
git status --short
cp .env .env.bak-preaidev
docker inspect mcp-hub-metamcp --format '{{.Config.Image}}'

# 1. clone the branch
git clone --branch ai-dev --depth 1 \
  https://github.com/metatool-ai/metamcp.git vendor/metamcp
SHA=$(git -C vendor/metamcp rev-parse --short HEAD)   # expect ff4ff2d
echo "vendor/" >> .gitignore

# 2. build, tagged into the ghcr namespace so compose picks it up unchanged
docker build -t "ghcr.io/metatool-ai/metamcp:ai-dev-$SHA" vendor/metamcp

# 3. flip the one line
sed -i "s/^METAMCP_VERSION=.*/METAMCP_VERSION=ai-dev-$SHA/" .env
docker compose up -d
node scripts/configure.mjs

# 4. verify
docker inspect mcp-hub-metamcp --format '{{.Config.Image}} {{.State.Health.Status}}'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:12008/metamcp/health
```

Then a real MCP smoke test against the hub endpoint: `initialize`, then
`tools/list`, and confirm the tool count comes back. Baseline is **94 tools
retrieved, 130 available**.

## Rollback

One line, then up:

```sh
sed -i 's/^METAMCP_VERSION=.*/METAMCP_VERSION=2.4.22/' /mnt/d/tools/Projects/mcp-hub/.env
cd /mnt/d/tools/Projects/mcp-hub && docker compose up -d
```

## Known traps

- **This restarts `mcp-hub-metamcp`**, dropping live MCP sessions for claude.ai
  and every attached agent. Expected and approved — do it once, cleanly.
- **Do not touch anything outside the `mcp-hub` compose project.** Not
  relay-queue, not cloudflared, not mindmeld, not the hue/nanoleaf containers.
- **hue and nanoleaf have a pre-existing cold-start `tools/list` timeout**
  (~60s first call, 0.7s warm). It was traced to those upstream containers, not
  to MetaMCP. This change will very likely **not** fix it. Do not chase it here.
- `mcp-hub` has **no git remote**. Nothing to push, and nothing recoverable if
  you clobber the working tree — hence the `.env.bak-preaidev` copy.

## Alternative target worth considering

The same README admits a maintenance gap —

> apologize for some recent maintainence delay, but will at least keep merging PRs

— and endorses a community fork:

> There is also a community maintained fork (ty a lot!):
> https://github.com/Umbrella-IT-Group/metamcp

Identical build effort. Swap the clone URL and the tag prefix if you'd rather
track that.

Tracked as Vikunja **#544** in *Agent Infrastructure*.
