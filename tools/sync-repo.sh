#!/bin/sh
# sync-repo — keep this checkout level with origin/main, forever, unattended.
#
# Runs as the relay-queue-sync sidecar. Every SYNC_INTERVAL seconds it fetches
# origin and fast-forwards the current branch. That is the deploy trigger: the
# working tree changes, server.js notices its own source moved, exits, and
# `restart: unless-stopped` brings it back on the new code.
#
# Rules this script will not break:
#   - **--ff-only, never a reset.** If local commits have diverged from
#     origin/main the merge simply refuses and the checkout is left exactly as
#     it was. Unpushed work is never destroyed, and never silently discarded.
#   - **Quiet when there is no origin at all.** A bare checkout with no remote
#     must idle harmlessly rather than spin on errors.
#   - **Honest about WHY a fetch failed, and only says it once.** The repo DOES
#     have a remote now (git@github.com:redaphid/relay-queue.git), so "no origin"
#     is no longer the interesting case — a fetch that fails does so for a
#     reason, and the reason matters. This script used to send fetch's stderr to
#     /dev/null and then announce "origin unreachable" for every failure alike.
#     That is a specific, confident diagnosis made after deliberately destroying
#     the only evidence, and it has been wrong: the live failure is `Host key
#     verification failed` — a missing known_hosts entry, i.e. AUTH — against an
#     origin that `git ls-remote` reaches perfectly well from the host. Two
#     separate people burned time hunting a network fault that did not exist.
#     So: print what git actually said, and diagnose nothing.
set -u

REPO=${REPO:-/repo}
SYNC_INTERVAL=${SYNC_INTERVAL:-60}
BRANCH=${SYNC_BRANCH:-main}

cd "$REPO" || { echo "[sync] $REPO is not readable — nothing to do"; exit 1; }

# The mount is owned by the host user; git refuses to operate otherwise.
git config --global --add safe.directory "$REPO" 2>/dev/null || true

echo "[sync] watching $REPO for origin/$BRANCH, every ${SYNC_INTERVAL}s"
warned_no_origin=0
warned_diverged=0
# The last fetch error we printed. Warn-once is keyed on the TEXT, not on a flag,
# so a steady failure stays quiet but a failure that CHANGES (auth cleared and
# now the network is down, say) still gets said. A flag would swallow that
# forever, which is the same silence this script is being fixed for.
last_fetch_err=''

while :; do
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    [ "$warned_no_origin" -eq 0 ] && echo "[sync] $REPO is not a git repo yet — idling"
    warned_no_origin=1
  elif ! git remote get-url origin >/dev/null 2>&1; then
    # Expected until the repo is published; say it once, then stay quiet.
    [ "$warned_no_origin" -eq 0 ] && echo "[sync] no 'origin' remote yet — idling until one is added"
    warned_no_origin=1
  else
    warned_no_origin=0
    # Keep stderr. It is the only thing that distinguishes "cannot log in" from
    # "cannot get there", and those have completely different fixes.
    fetch_err=$(git fetch --quiet origin 2>&1)
    fetch_rc=$?
    if [ "$fetch_rc" -eq 0 ]; then
      last_fetch_err=''
      before=$(git rev-parse HEAD 2>/dev/null)
      if git merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null; then
        warned_diverged=0
        after=$(git rev-parse HEAD 2>/dev/null)
        if [ "$before" != "$after" ]; then
          echo "[sync] fast-forwarded $(echo "$before" | cut -c1-8) -> $(echo "$after" | cut -c1-8)"
          git --no-pager log --oneline "$before..$after" 2>/dev/null | sed 's/^/[sync]   /'
        fi
      else
        # Local commits that are not on origin/main, or a dirty tree. Both are
        # fine — leave them completely alone and let a human sort it out.
        [ "$warned_diverged" -eq 0 ] && echo "[sync] cannot fast-forward to origin/$BRANCH — local commits kept, not touching the tree"
        warned_diverged=1
      fi
    else
      # Report git's words, not our guess at them. No claim about the network,
      # the remote, or whose fault it is — just what failed and what git said.
      if [ "$fetch_err" != "$last_fetch_err" ]; then
        echo "[sync] git fetch origin failed (exit $fetch_rc) — not syncing, tree untouched"
        if [ -n "$fetch_err" ]; then
          printf '%s\n' "$fetch_err" | while IFS= read -r line; do
            [ -n "$line" ] && echo "[sync]   $line"
          done
        else
          echo "[sync]   (git printed nothing to explain itself)"
        fi
        echo "[sync] will keep retrying every ${SYNC_INTERVAL}s; silent until this changes"
        last_fetch_err=$fetch_err
      fi
    fi
  fi
  sleep "$SYNC_INTERVAL"
done
