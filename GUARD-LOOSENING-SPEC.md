# Coordinator guard - loosening spec (applied)

**Status: APPLIED 2026-09-02**, in the commit that adds tools/coordinator-guard-selftest.js. Written 2026-09-02 by `auto-main-main` in relay
tab `main`, in response to: *"I want to loosen up the coordinator guards to allow
stuff like sed through, and other basic tools and operations that won't take a long
time and make this session unresponsive. I'm talking about tasks specifically
related to coordinator duties."*

Target file: `.claude/hooks/coordinator-guard.js`.

## Why this is a document and not a commit

An auto-seated coordinator cannot make this change, and hit both walls at once:

- **The guard blocks its own repair.** `Write`/`Edit` are markdown-only, so a `.js`
  file is refused; `sed` is in `NAMED` and denied, which is the exact complaint that
  prompted this task.
- **Delegation is unavailable too.** Two `Agent` dispatches carrying this spec were
  refused by the Claude Code auto-mode classifier, not by the guard. The guard's own
  denial text says "DELEGATE IT... subagents are exempt" - **for an auto-seated
  coordinator that escape hatch does not exist.** The two mechanisms together make
  the coordinator's fence airtight in a way neither was designed to be alone.

**To apply:** open an interactive Claude session rooted at this repo (or use any agent
not under the auto-mode classifier) and hand it this file.

## The policy bar

The guard fences the coordinator from taking slow or state-changing **actions**. It
is not an adversarial sandbox - the coordinator is trusted, just fenced against
drifting from routing into doing. So: **read-only and fast = allow; mutating,
long-running, or interactive = still deny.** That framing is what makes the changes
below safe, and it should be stated in the header comment.

---

## 1. Fix the `2>&1` bug - do this first, it is a real defect

`redirectTargets()` finds a `>`, skips spaces, then collects the target but breaks on
`[\s;|&]`. For `2>&1` the first character after `>` is `&`, so it collects an **empty**
target, and `isTempTarget('')` is false. **Every command containing `2>&1` is denied**,
with the nonsensical message ``It redirects output to ` ` ``. The `/^&\d+$/` fd-dup
branch in `isTempTarget` is unreachable dead code as a result.

Confirmed live on 2026-09-02: `ls .claude/ 2>&1; echo ---; ls tools/` was refused
under rule `write-outside-temp`.

**Fix:** when the character following the `>`/`>>` run is `&`, consume the `&` plus the
following digits (or `-`) as the target, so it reaches the existing fd-dup branch.
Check `cmd 2>&1`, `cmd >&2`, `cmd 2>>/tmp/x`.

## 2. Add to `INERT` - read-only and fast

`tac`, `paste`, `join`, `comm`, `column`, `fold`, `expand`, `unexpand`, `seq`,
`strings`, `od`, `xxd`, `hexdump`, `cksum`, `sha1sum`, `sha512sum`, `test`, `[`,
`printenv`, `id`, `groups`, `tty`, `locale`, `ps`, `pgrep`.

## 3. `sed` - allow as a read-only stream filter

Remove from `NAMED`; make it a conditional allow. **Deny only when an in-place flag is
present:** a word equal to `--in-place`, starting `--in-place=`, or matching
`/^-[A-Za-z]*i/` (covers `-i`, `-i.bak`, `-ni`, `-Ei`). Rule name `sed-in-place`.

Comment to include: the exotic write forms (`w file`, the `e` command) are **residual
accepted risk** - this guard fences accidental action, not an adversary, and every
heuristic for them false-positives on ordinary `s///` scripts.

## 4. `awk` / `gawk` / `mawk` - allow as a read-only filter

Deny when the segment after the command word matches
`/system\s*\(|\|&|\bclose\s*\(|>/`. Rule name `awk-side-effect`.

Comment to include: this deliberately false-positives on numeric comparisons like
`$1 > 5`. A visible over-refusal is the guard's stated design preference over a silent
hole, and the workaround (`$1 >= 6`, or delegate) is cheap.

## 5. `tee` - allow when every file argument satisfies `isTempTarget`

Otherwise deny under the existing `write-outside-temp` rule.

## 6. Read-only `git`

Allow `git` only when the subcommand is one of:

```
status log show diff blame branch tag rev-parse rev-list ls-files ls-tree
cat-file describe shortlog show-ref for-each-ref count-objects reflog
whatchanged grep stash worktree remote config
```

with these restrictions:

- **`branch` / `tag`** - no args, or only list-ish flags (`-l --list -a -r -v -vv
  --show-current --contains --merged --no-merged --sort --format --color
  --no-color`). Deny on any other non-flag argument, or any of
  `-d -D -m -M -c -C -f --force --edit-description --set-upstream-to --unset-upstream`.
- **`stash`** - only `list` / `show`. **`worktree`** - only `list`.
- **`remote`** - only no-args, `-v`, `--verbose`, `show`, `get-url`.
- **`config`** - only `--get`, `--get-all`, `--get-regexp`, `--list`, `-l`.
- **Deny outright** if a pre-subcommand global option is `-c`, `--exec-path`,
  `--upload-pack` or `--receive-pack`. Those inject config or aliases and are a real
  execution vector (`git -c core.pager=sh log`). `-C <dir>`, `--git-dir=`,
  `--work-tree=`, `--no-pager`, `-P` are fine.

Every other subcommand stays denied under rule `git`, with denial text saying
read-only git is permitted but this subcommand mutates state or takes network time.
`gh`, `hub`, `svn`, `hg` stay fully denied.

**Rationale:** the `INERT` comment already says the coordinator uses these "to verify
what its agents claim rather than taking reports on faith." Read-only git is the single
most useful instance of that and it changes nothing on disk.

## 7. Command substitution - vet recursively instead of blanket-denying

Today `scan()` flags any `$(`, backtick or `<(`, and `analyzeCommand` denies on sight.
This refuses ordinary things like `echo "$(date)"`.

Instead: **extract the substitution's inner text and analyze it with the same policy,
recursively**, depth cap 3 (exceeding it denies, rule `command-substitution-depth`).
Allowlisted inner command allows; otherwise deny **reporting the inner command's own
rule name**, so the message stays specific. Extract by balancing parens while tracking
quote state.

Keep `<(...)` process substitution denied as today (rule `command-substitution`) - it is
rare here and harder to reason about.

## 8. Keep denied, with a one-line comment each so nobody re-litigates

- **`sleep`** - the literal "makes this session unresponsive" case named in the request.
- **`xargs`** - executes arbitrary commands.
- **`less more man watch top htop vi vim nano`** - interactive or long-running. A pager
  blocking on a TTY is exactly the hang this guard exists to prevent. Add these to
  `NAMED` under rule name `interactive`, so the refusal reads clearly rather than as
  `not-allowlisted`.

Everything already in `NAMED` stays denied: node/python/perl/ruby, docker,
npm/pnpm/yarn/npx, make/cargo/go, package managers, systemctl, kill, ssh/rsync, the
file-mutation set, sudo, shells, eval.

- **`python3` was raised and REFUSED by the owner on 2026-09-02**, after a coordinator
  reported hitting it. Settled, not open. It stays in `NAMED` under rule `python`.
  The guard's blocks and their reasons are now stated in `CLAUDE.md` at the repo root,
  which every session rooted here loads.

## 9. Do NOT change

The subagent exemption; the markdown-only rule for `Write`/`Edit`/`MultiEdit`/
`NotebookEdit`; the relay-only URL restriction on `curl`/`wget`; the `find -exec`
denial; the deny-never-ask policy. Every path must still end in **allow** or **deny** -
never "ask", never silent fallthrough (an unanswered harness prompt parked the session
on 2026-08-17).

## 10. Update the header comment

Make the "THE FOUR EXCEPTIONS" summary match the new policy. **Keep the existing
rationale prose intact** - the parser-bug history and the location-coupling warning are
load-bearing institutional memory.

---

## The selftest to add

`tools/coordinator-guard-selftest.js`. There is no test for this guard today, in a repo
with 30 `*-selftest.js` files - read `tools/seat-release-selftest.js` first and match its
style and exit-code convention. It should spawn the guard as a child process, feed JSON
hook input on stdin, parse the decision from stdout, assert allow vs deny.

**Expect ALLOW:** `sed -n '1,20p' notes.txt`; `awk '{print $1}' notes.txt`;
`git status`; `git log --oneline -5`; `git diff HEAD~1`; `ls -la 2>&1`;
`cat a | tee /tmp/b`; `echo "$(date)"`; `curl -s http://127.0.0.1:3901/tasks`; a heredoc
whose **body** contains the literal text `git reset --hard abc` (the historical false
positive - must still pass); a `Write` to a `.md` path; any Bash call carrying
`agent_id` (subagent exemption).

**Expect DENY:** `sed -i 's/a/b/' notes.txt`; `awk 'BEGIN{system("id")}'`;
`git commit -m x`; `git push`; `git -c core.pager=sh log`; `git branch -d feature`;
`node server.js`; `python x.py`; `sleep 30`; `less notes.txt`; `mv a b`;
`curl https://example.com`; `echo "$(mv a b)"` (the recursion must catch it);
`tee /etc/hosts`; `find . -exec grep x {} ;`; a `Write` to a `.js` path; an unterminated
heredoc.

Then run `node .claude/skills/relay-coordinator/validate-routing.js` from the repo root
and confirm nothing broke.

## Constraints for whoever applies this

Work only in this repo. Do not commit or push without being asked. Do not restart the
server, touch `node_modules`, or run docker. **Do not edit `.claude/settings.json`** -
the hook registration is location-coupled to this directory and moving it silently turns
default-deny into default-allow. Leave the `.bak-*` files alone.

## The bigger finding, worth a decision

The guard tells a blocked coordinator to delegate, and the classifier then refuses the
delegation. **An auto-seated coordinator therefore has no path to any action at all** -
not even a one-word `sed`. That is wider than the guard's design intent, which assumed a
working escape hatch. Loosening the allowlist as above closes most of the gap; the rest
is a question about the classifier, which is a harness setting, not a relay one.
