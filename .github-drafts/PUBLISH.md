# Publishing relay-queue on GitHub

Copy-pasteable steps to file the drafts in this folder as issues.

**Corrected 2026-08-08 — the old version of this line said "no remote is configured and nothing has
been pushed". That is stale.** The repo is on GitHub, `origin` is
`git@github.com:redaphid/relay-queue.git`, and pushes from an agent succeed (branch `push-recipe-doc`
was pushed this way). So the publishing half below is largely done. What is still genuinely blocked is
**filing the issues**: that needs `gh`, which the agent sandbox refuses, so it needs his hands.

Run these from `D:\projects\relay-queue` in Git Bash. Requires the [`gh` CLI](https://cli.github.com/)
(`winget install GitHub.cli`), authenticated once with `gh auth login`.

---

## 0. Before anything — confirm no private data is about to be published

`data/` holds **real private messages**. It is gitignored, and nothing under it has ever been
committed. Verify that yourself rather than trusting it:

```bash
cd /d/projects/relay-queue

# Must print nothing at all. If it prints ANY path, stop and do not publish.
git log --all --name-only --pretty=format: | sort -u | grep -E '^data/' || echo "clean: no data/ file has ever been committed"

# Must confirm the ignore rule is live.
git check-ignore -v data/events.jsonl

# Skim what you are actually about to make public.
git ls-files
```

Expected published set: `.gitattributes`, `.github-drafts/*`, `.gitignore`, `README.md`,
`docker-compose.yml`, `package.json`, `public/index.html`, `server.js`, `tools/*`.

Also read `docker-compose.yml` once with fresh eyes: it contains **absolute host paths**
(`D:/projects/relay-queue/...`) and the machine's port layout. That is not a secret, but it is
personal infrastructure detail — decide if you mind it being public. There are no tokens or
credentials anywhere in the tree (the Cloudflare tunnel token lives in that container's own
configuration, not here — **keep it that way**).

## 1. Create the repo and push

```bash
gh repo create relay-queue --public --source=. --remote=origin --push \
  --description "Minimal durable local-only HTTP message queue with a mobile web UI and local voice dictation. Zero runtime dependencies."
```

That creates it, adds `origin`, and pushes `main` in one step. Confirm:

```bash
git remote -v
gh repo view --web
```

**The moment `origin` exists, the `relay-queue-sync` sidecar starts working.** It has been idling
("no 'origin' remote yet"). From now on it fast-forwards this checkout from `origin/main` every
60 s. Watch it pick up:

```bash
docker logs -f relay-queue-sync
```

## 2. File the drafts as issues

```bash
cd /d/projects/relay-queue/.github-drafts

for f in hands-free-voice-input https-for-mic-access make-ui-a-pwa headphone-push-to-talk authenticate-the-queue wake-word-hands-free; do
  title=$(head -1 "$f.md" | sed 's/^# //')
  gh issue create --title "$title" --body-file "$f.md"
  sleep 1
done

gh issue list
```

Labels are named at the top of each draft but are not created automatically. Either add them first
or drop the line:

```bash
for l in feature infra security ui voice design-ready speculative blocked-on-credentials; do
  gh label create "$l" 2>/dev/null || true
done
```

Once the issues exist, this folder has served its purpose — delete it and commit that, so the
drafts do not drift out of sync with the real issues:

```bash
cd /d/projects/relay-queue && git rm -r .github-drafts && git commit -m "Move issue drafts to GitHub issues" && git push
```

---

## 3. How to work on it from here — read this part

This checkout is **live infrastructure**: it is what the machine serves, and a sidecar is writing to
it every 60 seconds. That changes the rules.

**Agents should stop committing directly into `D:\projects\relay-queue`.** Work on a branch or, better,
a separate worktree, open a PR, and merge on GitHub. The merge is the deploy:

```bash
# a worktree keeps the live checkout completely untouched while you work
git -C /d/projects/relay-queue worktree add /d/projects/relay-queue-work -b my-change
cd /d/projects/relay-queue-work
# ...edit, commit...
git push -u origin my-change
gh pr create --fill
gh pr merge --squash        # ← this is the deploy
```

Within ~60 s the sidecar fast-forwards the live checkout, `server.js` notices its own source changed
and exits, and `restart: unless-stopped` brings it back on the new code. Confirm with:

```bash
docker logs --tail 20 relay-queue      # look for "changed (mtime poll) — exiting"
curl -s http://127.0.0.1:3901/health
```

Why this matters:

- The sync sidecar is **`--ff-only` and never resets**, so a local commit here is not destroyed —
  but it *does* block every future sync until someone resolves it by hand. The sidecar will say
  `cannot fast-forward to origin/main — local commits kept, not touching the tree` and then the
  machine silently stops receiving updates. Committing straight into this checkout is how you turn
  auto-deploy off without noticing.
- Uncommitted edits in the working tree will likewise make the merge refuse.

If you do end up with local commits here, push them rather than discarding them:

```bash
git -C /d/projects/relay-queue push origin main
```

## 4. Optional hardening

```bash
# require PRs into main, so nothing bypasses review on its way to being deployed
gh api -X PUT repos/:owner/relay-queue/branches/main/protection \
  -F required_pull_request_reviews.required_approving_review_count=0 \
  -F enforce_admins=false -F required_status_checks=null -F restrictions=null
```

Note that branch protection plus a squash-merge workflow means the live checkout only ever
fast-forwards, which is exactly what the sidecar wants.
