# Switch MetaMCP to the community fork (`Umbrella-IT-Group/metamcp`)

**Status:** chosen by Aaron 2026-09-02 in relay tab `mtjnrt3o-mdswsl`
("Go. Just do it" / "Yolo" / "Let's use the community fork").

**This supersedes `METAMCP-AI-DEV-RUNBOOK.md`.** That one built upstream's
`ai-dev` branch from source. This one does not build anything.

## What changed vs the ai-dev plan

| | ai-dev plan | this plan |
|---|---|---|
| source build | **required** (no `ai-dev` tag on ghcr) | **none** — prebuilt image |
| clone + `docker build` | yes | no |
| `.env` work | one line | two lines |
| rollback to 2.4.22 | one line, clean | **not supported** — see below |

The fork **auto-publishes to ghcr**. `.github/workflows/umbrella-build.yml`
fires `on: push: branches: [umbrella]` with `IMAGE_NAME: ${{ github.repository }}`
and tags `type=raw,value=latest` plus `type=sha,format=long`. So every push to
the default branch produces:

- `ghcr.io/umbrella-it-group/metamcp:latest`
- `ghcr.io/umbrella-it-group/metamcp:<full-sha>`

The `docker build` step that blocked the previous runbook simply does not exist
here.

## Why the fork rather than upstream `ai-dev`

Upstream's own README endorses it, and admits the gap:

> apologize for some recent maintainence delay, but will at least keep merging PRs
>
> There is also a community maintained fork (ty a lot!): https://github.com/Umbrella-IT-Group/metamcp

The fork's default branch is **`umbrella`** (not `main`). Its README describes
it as the maintained line covering the period upstream was unmaintained,
Feb–mid-Jun 2026. Additions relevant to this box:

- **Session recovery across restarts**, with capability hashing.
- **OAuth refresh tokens** — fixes the 60-minute disconnect. Access-token TTL
  default moves 1h → 24h, refresh 365d.
- **Connection-pool robustness**, `MAX_TOTAL_CONNECTIONS` (default 100).
- **RBAC** (admin/member) and audit logging.

## The one thing that is worse than the ai-dev plan: rollback

The fork adds its own tables — `mcp_sessions`, `audit_log`, `tool_call_audit`,
`gateway_events` — via `drizzle-kit migrate`, which runs **automatically on
boot**. The README states plainly that upgrading from upstream is supported and
**rollback to upstream is not**.

So `METAMCP_VERSION=2.4.22` is **no longer a safe one-line undo**. Take the
database backup in step 1. It is the actual rollback path.

## Preconditions — already satisfied, verified 2026-09-02

The hub's `.env` already defines every variable the fork requires:
`BETTER_AUTH_SECRET`, `BOOTSTRAP_USER_EMAIL`, `BOOTSTRAP_USER_PASSWORD`,
`BOOTSTRAP_DISABLE_REGISTRATION_UI`, `POSTGRES_*`, `DATABASE_URL`, `APP_URL`.

**No new env vars are needed.** This is a drop-in image swap.

## Run it

All paths are `/mnt/d/tools/Projects/mcp-hub` (WSL) = `D:\tools\Projects\mcp-hub`.

### 1. Back up first — this is the rollback

```sh
cd /mnt/d/tools/Projects/mcp-hub
cp .env .env.bak-prefork
docker compose exec -T postgres pg_dump -U metamcp_user metamcp_db \
  > ~/metamcp_db-prefork-$(date +%Y%m%d-%H%M).sql
```

Confirm the dump is non-empty before continuing.

### 2. Parameterise the image org in `docker-compose.yml`

Currently the registry path is hardcoded, so `METAMCP_VERSION` alone cannot
reach the fork:

```yaml
    image: ghcr.io/metatool-ai/metamcp:${METAMCP_VERSION:-2.4.22}
```

Change to:

```yaml
    image: ${METAMCP_IMAGE:-ghcr.io/metatool-ai/metamcp}:${METAMCP_VERSION:-2.4.22}
```

The default keeps upstream, so the file alone changes nothing.

### 3. Point `.env` at the fork

```sh
sed -i 's|^METAMCP_VERSION=.*|METAMCP_VERSION=latest|' .env
grep -q '^METAMCP_IMAGE=' .env \
  || echo 'METAMCP_IMAGE=ghcr.io/umbrella-it-group/metamcp' >> .env
```

### 4. Pull explicitly, then bring it up

```sh
docker compose pull metamcp
docker compose up -d
docker compose logs -f metamcp   # watch drizzle-kit migrate run
```

`docker compose pull` is **not optional**: the service sets
`pull_policy: missing`, so once a local `:latest` exists it will never refresh
on its own.

### 5. Re-apply the upstream wiring and verify

```sh
node scripts/configure.mjs
curl -s http://127.0.0.1:12008/metamcp/health
```

Then confirm from a client that the aggregated tools still list.

### 6. Pin the SHA (do this once it is known good)

`:latest` is a moving target and the fork pushes it on every merge.

```sh
docker inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/umbrella-it-group/metamcp:latest
```

Record the matching `:<full-sha>` tag in `.env` in place of `latest`, and mirror
both new lines into `.env.example`.

## Known warnings

- **It restarts `mcp-hub-metamcp`** — drops live claude.ai and agent MCP
  sessions. Ironically this is the last time that should hurt: session recovery
  across restarts is the fork's headline fix.
- **It will not fix the hue/nanoleaf cold-start stall.** That was traced to
  those upstream containers, not to MetaMCP.
- **Registration UI is closed by default** in the fork
  (`BOOTSTRAP_DISABLE_REGISTRATION_UI=true`). The hub already sets this, so no
  change — but do not expect the open sign-up page.
- **Single-tenant posture:** the fork does not forward per-caller identity to
  backends. Not a regression for this box; it is one user.

## Verified against the real files, 2026-09-02 06:35

Every assumption in the steps above was checked on disk, not inferred:

| claim | actual |
|---|---|
| image line is hardcoded to the upstream org | **yes** - `docker-compose.yml:17`, `image: ghcr.io/metatool-ai/metamcp:${METAMCP_VERSION:-2.4.22}` |
| `pull_policy: missing`, so `pull` is mandatory | **yes** - `docker-compose.yml:19` |
| postgres compose service name | **`postgres`** (container `mcp-hub-postgres`, `postgres:16-alpine`) |
| pg_dump credentials | `POSTGRES_USER=metamcp_user`, `POSTGRES_DB=metamcp_db` - both correct as written above |
| `METAMCP_IMAGE` already set somewhere | **no** - absent from `.env`, `.env.example`, compose and `scripts/`. Step 3 really does have to add it |
| current tag | `METAMCP_VERSION=2.4.22` |
| `scripts/configure.mjs` exists | **yes**, executable |

One thing worth knowing before you run it: **postgres has no published host
port** - deliberately, because the host already runs postgres on 5432 and
mindmeld-postgres on 5433. So the backup must go through
`docker compose exec`, as step 1 does. A host `pg_dump` will not reach it.

## Copy-paste block

Runs steps 1-5 in order and stops on the first failure. The `sed` for the
compose file preserves the existing indentation.

```sh
set -e
cd /mnt/d/tools/Projects/mcp-hub

# 1. backup - this is the only rollback
cp .env .env.bak-prefork
DUMP=~/metamcp_db-prefork-$(date +%Y%m%d-%H%M).sql
docker compose exec -T postgres pg_dump -U metamcp_user metamcp_db > "$DUMP"
grep -q 'CREATE TABLE' "$DUMP" || { echo "EMPTY DUMP - STOP"; exit 1; }
wc -c "$DUMP"

# 2. parameterise the registry org (default keeps upstream, so this alone is a no-op)
sed -i 's|^\( *\)image: ghcr.io/metatool-ai/metamcp:|\1image: ${METAMCP_IMAGE:-ghcr.io/metatool-ai/metamcp}:|' docker-compose.yml
grep -n 'image: .*metamcp' docker-compose.yml

# 3. point .env at the fork
sed -i 's|^METAMCP_VERSION=.*|METAMCP_VERSION=latest|' .env
grep -q '^METAMCP_IMAGE=' .env || echo 'METAMCP_IMAGE=ghcr.io/umbrella-it-group/metamcp' >> .env

# 4. pull explicitly, then up
docker compose pull metamcp
docker compose up -d
sleep 20
docker compose logs --tail 200 metamcp

# 5. rewire and verify
node scripts/configure.mjs
curl -s http://127.0.0.1:12008/metamcp/health
```

**If step 4 fails**, undo is:

```sh
cd /mnt/d/tools/Projects/mcp-hub
cp .env.bak-prefork .env
docker compose up -d
```

and if the schema is already migrated, restore `$DUMP` on top of that.
