# Copy/paste launch prompt - relay hooks, liveness, guard

Written 2026-09-02 by `auto-relay-7qm5` for tab `Relay` (`mtjhp9tt-897qm5`).
Everything below the line is the prompt. Paste it into a fresh Claude Code session.

**Launch it from the WSL checkout, not `D:\`:**

```
wsl -d Ubuntu --cd /home/hypnodroid/Projects/relay-queue -- claude
```

`D:\projects\relay-queue` is a **stale copy** (server.js dated Aug 28, tree untouched
since Aug 29). The live repo, the live guard and autoseat's spawn cwd are all the WSL
path. Working in the wrong one silently does nothing.

---

You are working in `/home/hypnodroid/Projects/relay-queue`, the live relay-queue repo,
inside WSL on a Windows host. Ignore `/mnt/d/projects/relay-queue` entirely - it is a
stale checkout and editing it has no effect.

## Read these first, in this order

1. `.claude/skills/relay-coordinator/SKILL.md` - the API and its documented traps.
2. `GUARD-LOOSENING-SPEC.md`
3. `HOOKS-LIVENESS-SPEC.md`
4. `GUARD-VIOLATIONS-API-SPEC.md`
5. `WSL-LAUNCHER-SPEC.md`

Specs 2-5 are complete, reviewed, and ready to apply. They were written by auto-seated
coordinators that could not apply them. **Implement them; do not re-derive them.** Where
a spec states a judgement call, it is already decided - the open questions are listed at
the end of this prompt and only those.

**Before Phase 1, commit what is already in the tree.** He asked for this explicitly on
2026-09-02 and no agent has been able to do it: `.claude/hooks/coordinator-guard.js` and
`tools/autoseat.js` are modified, and the five spec documents are untracked. Split it
into logical commits, match the voice of `git log -20 --format=%s`, and push to
`origin main`. Run `node --check` on both `.js` files first - a guard that does not parse
fences every coordinator on this machine.

**Then restart autoseat.** `tools/autoseat.js` already has `maxConcurrent: 6` in the
tree, but the running supervisor (pid 18219 as of 03:24 on 2026-09-02) is on the old code
and still capped at 3, which is why tabs were starving. The edit does nothing until the
process is restarted. While there, `--max-concurrent`'s help text at `tools/autoseat.js`
still says "default 3" and the programmatic default at line ~158 is still `3`; make all
three agree.

## Before anything else: you are inside the coordinator guard, and it will block you

`.claude/settings.json` in this repo registers `.claude/hooks/coordinator-guard.js` on
`PreToolUse` for `Bash|PowerShell|Write|Edit|NotebookEdit`. It is **default-deny**, and
it applies to the main session thread whether or not that session is interactive. It
will refuse you `node`, `npm`, `git commit`, `sed`, and any `Write`/`Edit` to a
non-markdown path. Claude Code loads `settings.json` only for the directory the session
is rooted in, so you get it precisely because you are rooted here.

`coordinator-guard.js:529` exempts a call whose hook input carries `agent_id` - i.e.
**subagent tool calls are exempt.** That is the supported path.

So: **do the `.js` and `.json` work through subagents (the Task/Agent tool), and use your
main thread for reading, planning and markdown.** `Read`, `Grep`, `Glob` and `Task` are
not in the guard's matcher at all and are unrestricted.

### Step 0 - create `.claude/settings.local.json` with an explicit allowlist

Do this first, so your subagents are not stopped by permission prompts on every call.
Write it to `settings.local.json`, **not** `settings.json`: the hook registration in
`settings.json` is location-coupled and both specs say do not disturb it.

```json
{
  "permissions": {
    "allow": [
      "Read", "Grep", "Glob", "Task", "TodoWrite",
      "Write", "Edit", "MultiEdit",
      "Bash(node:*)",
      "Bash(node tools/*)",
      "Bash(npm test:*)",
      "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
      "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(wc:*)",
      "Bash(sed:*)", "Bash(awk:*)", "Bash(diff:*)", "Bash(cut:*)", "Bash(sort:*)",
      "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(chmod:*)", "Bash(touch:*)",
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
      "Bash(git show:*)", "Bash(git add:*)", "Bash(git stash list:*)",
      "Bash(curl -s http://127.0.0.1:3901/*)",
      "Bash(curl -s -X POST http://127.0.0.1:3901/*)",
      "Bash(curl:*127.0.0.1:3901*)"
    ],
    "deny": [
      "Bash(git push:*)",
      "Bash(git commit:*)",
      "Bash(docker:*)",
      "Bash(rm -rf:*)",
      "Bash(curl:*trycloudflare*)",
      "Bash(cloudflared:*)"
    ]
  }
}
```

Two things this file does **not** do, deliberately: it does not disable the coordinator
guard, and it does not grant network access beyond `127.0.0.1:3901`. Relay has no auth of
its own and must never be exposed on a public URL - not even briefly.

Verify after writing it: run one denied command from your **main** thread (e.g.
`node -e "1"`) and confirm the guard still refuses it. A guard that silently stopped
firing is the failure mode this repo warns about most.

## The work, in order

### Phase 1 - `GUARD-LOOSENING-SPEC.md`

Do section 1 (the `2>&1` parser bug) first and independently: it is a live defect,
confirmed twice, most recently on 2026-09-02 when `ls -la <paths> 2>&1 | head -20` was
refused under `write-outside-temp` with the message ``It redirects output to ` ` ``.
Then sections 2-8, then `tools/coordinator-guard-selftest.js` with the exact ALLOW/DENY
cases the spec lists. Do not weaken anything in the spec's section 9.

### Phase 2 - `HOOKS-LIVENESS-SPEC.md`

Claude hooks that report tool activity into the relay UI, and count as a liveness signal.
Note two amendments already folded into the file:

- The hook's socket timeout is **15 s**, not 250 ms (set by the human on 2026-09-02), and
  `timeout: 20` in settings so the harness does not kill the hook first.
- **That 15 s is only safe because the POST must be detached** - issue it,
  `socket.unref()`, exit 0 without awaiting the response. A 15 s *blocking* hook on every
  tool call would be ruinous. The selftest asserts the unreachable-relay case returns in
  well under 15 s.

Section 2a (amending the `NOTHING HERE FEEDS LIVENESS` comment at `server.js:314`) is
listed as "do this first" and means it: leaving that comment intact while the code stops
honouring it is worse than not shipping the feature.

### Phase 3 - `GUARD-VIOLATIONS-API-SPEC.md`

`POST`/`GET /guard-violations` plus `/summary`, durable in
`data/guard-violations.jsonl`, and the guard change that stops it posting violation
reports as **messages into the `main` tab**. That current behaviour turns a log line into
a pending task a human has to close by hand - there was one sitting in the `Relay` tab
while the spec was being written.

Phase 3 reuses the redactor and `RELAY_CONVERSATION_ID` from Phase 2. **One redactor,
both callers.** Do Phase 2 first.

### Phase 4 - `WSL-LAUNCHER-SPEC.md`

A daemon that starts Claude sessions in allowlisted project directories, driven from
relay. It **polls** relay over `127.0.0.1` and opens no inbound port - that decision is
section 1 of the spec and is not negotiable, because a second inbound surface in WSL sits
outside Cloudflare Access and is unauthenticated RCE on the host.

Do this **last**, but understand why it matters most: it is the only item in this backlog
that removes the reason the backlog exists. Auto-seated coordinators cannot write `.js`,
cannot run `node`, and cannot delegate (the Agent dispatch is refused by the auto-mode
classifier, not by the guard - confirmed twice from tab `Guard Loosening` on 2026-09-02,
once for `git commit` and once for a pure source-edit subagent). Phase 4 turns "paste a
prompt into a terminal when you next sit down" into a button on a phone.

It reuses the redactor from Phase 2 as a third caller.

## How to run this

- Delegate each phase to a **named** subagent (`GuardLoosen`, `HooksLiveness`,
  `GuardAudit`) - the names show up in the relay UI. Phases 1 and 2 are independent and
  can run in parallel; Phase 3 waits on Phase 2.
- Each subagent runs its own selftest and reports pass/fail with real output. Do not
  accept "should work".
- Finish with `node .claude/skills/relay-coordinator/validate-routing.js` from the repo
  root, plus `node tools/autoseat-selftest.js`.

## Constraints

- Work only in this repo. **Do not commit or push** unless asked - staging with `git add`
  is fine.
- **Do not restart the server by hand.** It restarts itself on source change; expect open
  SSE streams to drop when it does.
- Do not touch `node_modules` or docker. Leave the guard's `.bak-*` files alone.
- Do not expose relay on any public URL, tunnel, or `trycloudflare.com` address.
- Do not archive, share, or publish any relay conversation. That is the human's call from
  the UI, and `POST /conversations/:id/share` is the one genuinely destructive route here.
- Post progress into relay tab `mtjhp9tt-897qm5` as you go
  (`POST http://127.0.0.1:3901/messages` with
  `{"conversationId":"mtjhp9tt-897qm5","agent":"<your name>","text":"..."}`),
  ASCII only in the body. Keep posts short and bulleted - they are read on a phone.

## The only open questions - ask, do not assume

*(The tool-rows-vs-`working` question that used to head this list is **answered**: on
2026-09-02 the human said *"If it uses tools, then it should be considered working."*
`HOOKS-LIVENESS-SPEC.md` sections 2a, 2d, 5, 6 and 8 have been rewritten accordingly -
tool activity satisfies `working`, there is no `busy` state, and `stalePending()` is
untouched. Implement it as written; do not re-open it.)*

1. **Does the share snapshot include the activity feed?** If it does, hook rows become a
   new class of content on a public page. Check `share.js` and surface it rather than
   inheriting the decision.
2. **`WSL-LAUNCHER-SPEC.md` section 10, both questions.** How wide is the launcher
   allowlist on day one (it ships with `relay-queue` alone), and may a launch name its
   own permission mode or must it inherit the target's `.claude/settings.local.json`?
   The spec assumes inherit, and flags that as the one place where the more useful
   answer is also the weaker one. **He has not answered either.**
