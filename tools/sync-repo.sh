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
#   - **Quiet when origin is missing or unreachable.** The repo has no remote
#     until someone publishes it (see .github-drafts/PUBLISH.md), so a bare
#     checkout must idle harmlessly rather than spin on errors.
set -u

REPO=${REPO:-/repo}
SYNC_INTERVAL=${SYNC_INTERVAL:-60}
BRANCH=${SYNC_BRANCH:-main}

cd "$REPO" || { echo "[sync] $REPO is not readable — nothing to do"; exit 1; }

# The mount is owned by the host user; git refuses to operate otherwise.
git config --global --add safe.directory "$REPO" 2>/dev/null || true

echo "[sync] watching $REPO for origin/$BRANCH, every ${SYNC_INTERVAL}s"
warned_no_origin=0
warned_unreachable=0
warned_diverged=0

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
    if git fetch --quiet origin 2>/dev/null; then
      warned_unreachable=0
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
      [ "$warned_unreachable" -eq 0 ] && echo "[sync] origin unreachable — will keep trying quietly"
      warned_unreachable=1
    fi
  fi
  sleep "$SYNC_INTERVAL"
done
