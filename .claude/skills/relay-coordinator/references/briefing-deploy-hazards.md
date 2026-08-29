# BRIEFING MATERIAL - relay-queue deployment hazards

**This is material to PASTE INTO A SUBAGENT BRIEF. The coordinator does not run
any of it.** Every command here is `git`, `rm`, `Remove-Item` or `cmd /c rmdir`,
all of which the coordinator guard denies (default-deny: only relay-targeted
`curl`/`wget`, markdown writes, and inert inspection are permitted).

Read when: you are about to dispatch an agent to deploy, merge, bisect, do git
archaeology, delete a worktree, or touch `node_modules` in this repo.

`D:\projects\relay-queue` **is** the live deployment — the server watches its own source, and `public/` is bind-mounted and served straight off disk.

- **Never edit the main checkout directly.** `git worktree add ../probe -b <branch> main`, work there, merge.
- **Front-end changes deploy the instant the file is written** — no restart, no window to catch a mistake. Finish checks *before* merging.
- **Any git command that rewrites the working tree is a deploy**: `checkout`, `bisect`, `stash`, `reset --hard`, `revert`, a speculative `merge`, even `cherry-pick --no-commit`. Do archaeology in a scratch worktree (`git worktree add /tmp/probe --detach main`), never in the main checkout.
- **Verify a deploy at `/`, never `/index.html`** — the latter falls through to a 46-byte JSON 404 that looks exactly like a failed ship.
  ```sh
  curl -s http://127.0.0.1:3901/ | grep -c 'YOUR MARKER'
  curl -s http://127.0.0.1:3901/ | wc -c   # compare to: wc -c < public/index.html
  ```
- **Some worktrees have `node_modules` as a Windows junction into this repo's real one.** A recursive delete (`rm -rf`, `Remove-Item -Recurse`, `git worktree remove`, Explorer) follows the junction and destroys the live app's dependencies. Before deleting: `Get-Item <path> -Force` and check `LinkType`/`Target`. If it's a junction, unlink first (`cmd /c rmdir "<path>"`, no `/s`), *then* remove the worktree.
- **Don't bisect this repo outside a worktree.** An environmental fault (e.g. a stray process squatting a hardcoded test port) launders into a false, confident commit blame; a clean-boundary bisect result is grounds for suspicion, not confidence, until reproduced in a fresh environment on a free port.
- **Rollback commands you hand to a human must survive a moving base.** `ORIG_HEAD` is one slot, overwritten by the next HEAD-moving operation from anyone. Use a ref only the human controls: `git branch pre-merge-backup` / `git tag pre-merge-backup` before merging, then `git reset --hard pre-merge-backup`.
- Standing deploy authorization exists for this repo (commit/push/deploy without asking) — the worktree-and-checks discipline above still applies regardless.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
