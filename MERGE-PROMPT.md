# Copy/paste prompt - land the parked branches, revive the deploy path

Written 2026-09-02 by `auto-relay-2-alin` for tab `Relay 2` (`mtjoh7o0-nwalin`).
Everything below the line is the prompt. Paste it into a fresh Claude Code session.

**Launch from the WSL checkout:**

```
wsl -d Ubuntu --cd /home/hypnodroid/Projects/relay-queue -- claude
```

Companion document: `LAUNCH-PROMPT.md` is the prompt for the four *spec* phases
(guard loosening, hooks liveness, guard-violations API, WSL launcher). This one is
merges and deploy plumbing only. **Do this one first** - it makes the tree clean
enough that the spec work has somewhere to land.

---

You are in `/home/hypnodroid/Projects/relay-queue`. You know relay already; this is
not an introduction. The job is to land ten months of parked branches and fix the
dead auto-deploy, in that order.

**You are inside the coordinator guard** (`.claude/hooks/coordinator-guard.js`,
registered by `.claude/settings.json` for this directory, default-deny on the main
thread). It refuses `node`, `git commit`, `git merge`, `git push`, `docker`, `sed -i`,
and any `Write`/`Edit` to a non-markdown path. **Subagent tool calls are exempt**
(`coordinator-guard.js:529` checks for `agent_id`). So: read, plan and write markdown
on the main thread; do every mutation through a named subagent. Do not disable or edit
the guard registration.

## Phase 0 - the uncommitted server.js is the blocker, deal with it first

`git status` shows `server.js` modified: **+462 / -9**, a complete `POST /terms` +
STT-overlay feature (`TERMS_OVERLAY_FILE`, `termsStamp`, `readTermsFile`,
`mergeTerms`) that exists **nowhere in git**. It is not a stray edit:

- `GET /terms` on the live server answers **200**, so the running process is serving
  this code. The checkout is bind-mounted `:ro` into the container and `server.js`
  exits on source change, so the working tree *is* the deployment.
- Every merge below touches `server.js`. Merging onto a dirty tree either refuses or
  buries this in a conflict, and `git stash`/`git checkout -- server.js` would
  silently roll back a live feature at the next restart.

So: **commit it before you merge anything.** Read the diff, confirm it stands on its
own, commit it to `main` with a message in the voice of `git log -20 --format=%s`.
Also untracked and needing a decision: `METAMCP-AI-DEV-RUNBOOK.md`,
`METAMCP-FORK-RUNBOOK.md`, `pnpm-lock.yaml` (the repo has `package-lock.json` - decide
whether pnpm is intentional before committing a second lockfile).

## Phase 1 - the merges

`integration/gated-merges` is the staging branch: `main` + 8 commits, already folding
in `wsl-cutover-config`, `coordinator-protocol-rules`, `stt-terms` and
`wsl-guard-paths`. Every remaining live branch is **`integration/gated-merges` plus
exactly one commit**, so this is seven merges, not ten:

| # | branch | unique commit | touches |
|---|---|---|---|
| 1 | `integration/gated-merges` | (8) | docs, compose, stt-terms.json, guard |
| 2 | `seat-lifecycle` | `3bb294d` | `server.js` +273, `public/index.html`, selftest |
| 3 | `api-ergonomics` | `f066372` | `server.js` +157, new `staffability.js`, `tools/autoseat.js`, selftests |
| 4 | `autoseat-obs` | `d63d84d` | `tools/autoseat.js` +371, selftest |
| 5 | `token-diet` | `cd5cd17` | `server.js` +45, `tools/autoseat.js` +40, 2 selftests |
| 6 | `tts-double-read` | `3f90ceb` | `public/index.html`, `tools/ui-selftest.js` |
| 7 | `carry/d-tree-untracked-docs` | `434e54d` | 2 markdown files only |

`wsl-cutover-config` is redundant - `main` already carries the identical change.

**Merge in the order above, and understand why:** `server.js` is touched by 2, 3 and 5;
`tools/autoseat.js` by 3, 4 and 5. Largest-first means later merges rebase their
context onto settled code instead of the reverse. Expect real conflicts on
`server.js` and `tools/autoseat.js`; do not resolve them by taking one side wholesale.

**After each merge, before the next one:**

- `node --check server.js tools/autoseat.js` (and any other `.js` the merge touched).
- Run the selftests the merge brought with it - `tools/api-ergonomics-selftest.js`,
  `tools/autoseat-doa-selftest.js`, `tools/seat-lifecycle-selftest.js`,
  `tools/autoseat-nomcp-selftest.js`, `tools/sse-pending-selftest.js`,
  `tools/ui-selftest.js` - plus `tools/autoseat-selftest.js` and
  `node .claude/skills/relay-coordinator/validate-routing.js` every time.
- Report real output. "Should pass" is not a result.

**The server redeploys itself the moment `server.js` changes on disk.** Every merge is
a live deploy. Do not restart it by hand; expect open SSE streams (including your own)
to drop. If a merge leaves `server.js` broken, the relay UI goes down with it - so a
failing `node --check` means fix or `git merge --abort`, immediately, not later.

## Phase 2 - the dead sync sidecar

`relay-queue-sync` (`alpine/git`, `docker-compose.yml:104`, `tools/sync-repo.sh`) has
been failing every 60s with:

```
ssh: connect to host github.com port 22: Connection refused
```

Outbound **ssh/22 is blocked from that container**, so nothing from `origin` reaches
the checkout any more. The checkout only advances when someone runs a fetch by hand.

The fix is GitHub's SSH-over-443 endpoint, not turning off host-key checking. In
`tools/sync-repo.sh:68`, `GIT_SSH_COMMAND` is already fully explicit - add the
alternate host and port there rather than rewriting `origin`'s URL (the comments at
`docker-compose.yml:116-129` explain why the shared URL is deliberately left alone).

**The trap:** `ssh.github.com` is a different hostname, so the mounted
`known_hosts` (`/mnt/c/Users/hypnodroid/.ssh/github_known_hosts`) will not match it and
`StrictHostKeyChecking=yes` will fail closed. Add `ssh.github.com`'s entries - the host
keys are the same material published at `api.github.com/meta`, just under a second
name. **Do not "fix" this with `StrictHostKeyChecking=no`.** That failure mode already
burned two people for days once, and the comment block in `sync-repo.sh` exists
specifically because of it.

Verify from inside the container, with the real key and the real known_hosts, that
`git fetch` succeeds - not just that `ssh -T` connects.

If ssh/443 is also blocked, the fallback is an HTTPS remote with a read-only
fine-grained PAT mounted the same way as the deploy key. Ask before going there; it
changes the credential model.

## Phase 3 - push

`main` is **1 commit ahead of `origin/main`** and unpushed (`0369881`, raise autoseat
cap to 6). After the merges, push everything. Until the sidecar is fixed, pushing is
what makes the deploy path meaningful at all.

While you are there: `tools/autoseat.js` has `maxConcurrent: 6` in the tree, but the
running supervisor is on older code. **The process never reloads** - compare
`ps -o lstart` against the file mtime and restart it, or the cap change does nothing.

## Constraints

- **Do not** archive, share, or publish any relay conversation.
- **Do not** expose relay on any public URL or tunnel. It has no auth of its own.
- **Do not** touch `node_modules`, and leave the guard's `.bak-*` files alone.
- **Do not** weaken the coordinator guard to make your own life easier. Delegate.
- Post progress into relay tab `mtjoh7o0-nwalin`:
  `POST http://127.0.0.1:3901/messages` with
  `{"conversationId":"mtjoh7o0-nwalin","agent":"<your name>","text":"..."}`.
  **Pure ASCII in the body** - an em-dash kills the POST. Short and bulleted; it is
  read on a phone.

## Ask, do not assume

1. **`pnpm-lock.yaml`** - commit it, or delete it? The repo tracks
   `package-lock.json`.
2. **The 462 uncommitted `server.js` lines** - commit as-is, or review first? It is
   live either way; the only question is whether it gets a review before it gets a
   commit.
3. **`origin`'s stale branches.** There are ~20 remote branches including
   `pre-*-backup`, `quarantine/*` and `wip/*`. Out of scope here, but worth a decision
   once the live ones have landed.
