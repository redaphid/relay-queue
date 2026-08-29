# LEGACY - Windows-only mechanics

**Status: legacy.** This box runs Windows today, so everything here is live.
The stated direction is to run relay on Linux, at which point this whole file
is deleted in one `rm` and its routing row removed with it. Nothing else in the
skill depends on it.

**Read only when** a Windows detail is actually in your way: a JSON body the
server refused, a `.ps1` that will not parse, the `relay-autoseat` Scheduled
Task, or a delete that might follow an NTFS junction.

**Nothing here is a relay protocol rule.** The protocol rules stayed in
`SKILL.md`; what moved here is only the OS-shaped mechanism behind them. If you
find yourself reading this file to learn what relay does, you are in the wrong
file.

## Shell text encoding - the Windows half of the ASCII rule

The core rule ("plain ASCII in any JSON body; read the response") is in
`SKILL.md` under **Tasks** and is platform-independent - the server refuses a
non-UTF-8 body outright and stores nothing, on any OS.

The Windows-specific part is *why the bytes go wrong in the first place*: this
box's shell re-encodes an em-dash or a smart quote on its way into `curl`,
delivering a lone CP-1252 byte (an em-dash arrives as `0x97`) rather than the
UTF-8 sequence. The text looked fine when you typed it. Send bytes you control:

```sh
curl --data-binary @body.json ...          # write the JSON to a file first
# PowerShell: pass ([System.Text.Encoding]::UTF8.GetBytes($json)) as the body
```

The refusal names the character that broke and how to fix it.

## Serializing a JSON body on this box

The core rule - serialize with a serializer, never hand-roll a heredoc, and
never hand the body between two tools through a temp file - is in `SKILL.md`.
The Windows mechanics behind it:

- **PowerShell + `ConvertTo-Json` + a UTF-8 byte body is the reliable path
  here.** `node -e` hits Git-Bash path translation.
- **`/tmp` is not one directory.** node writes `/tmp/x.json` to `C:\tmp\`;
  MSYS `curl @/tmp/x.json` reads `%TEMP%\`. They are different files, and the
  mismatch does not error - it silently reads whatever stale file was already
  there. If you must cross tools, use an agent-namespaced absolute Windows path,
  not `/tmp`.

## `.ps1` files must be pure ASCII

**PowerShell reads an unsigned script as CP-1252, not UTF-8.** A single UTF-8
em-dash inside a string literal is decoded as multiple CP-1252 characters, one
of which terminates the literal early, and the script **fails to parse** - at
boot, where nobody is watching.

This is a live protection, not history: `tools/autoseat-start.ps1` is executed
by the Scheduled Task below every 5 minutes right now. A parse failure there
stops auto-seating silently.

- Assert pure ASCII on every `.ps1` before shipping it, and **prove the check
  can go red** with a deliberate em-dash control.
- Also parse-check them: `[Parser]::ParseFile`, with a deliberately broken
  control to confirm the check reports errors.

## Scheduled Task supervision of autoseat

**This is material to PASTE INTO A SUBAGENT BRIEF. The coordinator does not run
any of it.** Every command below is `powershell` against Windows Task Scheduler,
which the coordinator guard denies outright (default-deny allowlist: only
`curl`/`wget` aimed at relay, markdown writes, and inert inspection are
permitted). A coordinator that reads this and tries to act on it is refused.

**`relay-autoseat` (Windows Task Scheduler) is what keeps autoseat alive** - at
logon, and again every 5 minutes forever. Check it, rather than assuming, before
concluding auto-seating is armed:

```sh
powershell -NoProfile -Command "(Get-ScheduledTask relay-autoseat).State"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'autoseat\.js' } | Select ProcessId"
powershell -ExecutionPolicy Bypass -File tools\autoseat-install-task.ps1   # (re)install
```

`tools/autoseat-start.ps1` is the idempotent starter (**no-ops when a `node.exe`
is already running `autoseat.js`**, which is what makes a 5-minute trigger a
supervisor instead of a fork bomb); `tools/autoseat-start.vbs` only exists to
suppress the console flash every tick would otherwise put on his desktop.

- **This was added because the supervisor used to be a person remembering.** The
  log shows autoseat watching continuously from `2026-08-28 00:50:36` to
  `2026-08-29 00:32:56`, then stopping mid-stream with an **empty `.err.log`** -
  no crash and no stack, just a parent terminal closing and taking the process
  with it. Twenty minutes later a human message sat in a tab for 14+ minutes
  with nobody seated: the exact failure autoseat exists to prevent, reintroduced
  one level up the stack. **A mechanism whose own liveness depends on a human is
  not a fix, it is a relocation of the same bug.**
- **The liveness check matches `node.exe` specifically, and that filter is
  load-bearing.** The start script's own path contains the string `autoseat`,
  and so does the `wscript`/`powershell` command line launching it, so a bare
  `CommandLine -match "autoseat"` finds *itself*, concludes autoseat is already
  up, and starts nothing - forever, while reporting success. A check that cannot
  return "no" is not a check.
- **Known limit, by choice:** an Interactive-logon task does not run while
  nobody is logged on. A locked screen is fine; a logged-out box means no
  auto-seating until he logs in. The alternative (S4U) runs in **session 0**,
  and nothing here has established that `claude` authenticates correctly from
  session 0. **Test that before switching the LogonType**; do not just change it
  and assume.

## Deleting anything under a worktree - NTFS junctions

**Some worktrees have `node_modules` as a Windows junction into this repo's real
one.** A recursive delete (`rm -rf`, `Remove-Item -Recurse`, `git worktree
remove`, Explorer) follows the junction and destroys the live app's
dependencies.

Before deleting: `Get-Item <path> -Force` and check `LinkType`/`Target`. If it
is a junction, unlink first (`cmd /c rmdir "<path>"`, **no `/s`**), *then*
remove the worktree.

The platform-independent deployment rules are in
`briefing-deploy-hazards.md`.

## CRLF silently no-ops in-place mutations

`sed -i` and `perl -0pi` **match nothing against a CRLF file on this box and
exit 0.** Every mutation is reported as applied when none was, which turns a
mutation-testing run into a page of fake "survived" results - a green that was
never measured.

- Verify every mutation actually landed: assert a match count (`grep -c`), or
  make the edit with a tool that fails loudly when the match is missing.
- `tools/autoseat-selftest.js` sidesteps this by mutating **in memory** and
  asserting the match count is exactly 1. See `autoseat.md`.
- This repo now pins `.claude/** text eol=lf` and `*.sh text eol=lf` in
  `.gitattributes`, so those trees are LF in the working copy. The rest of the
  repo is not pinned, and this box's global `core.autocrlf` is `true`.

## Windows paths that are still real

Incidental Windows paths were removed from the core manual; these are the ones
you may still need:

| what | path |
|---|---|
| the repo / live deployment / coordinator spawn cwd | `D:\projects\relay-queue` |
| this skill | `D:\projects\relay-queue\.claude\skills\relay-coordinator\` |
| the guard and its registration | `D:\projects\relay-queue\.claude\hooks\coordinator-guard.js`, `.claude\settings.json` |
| autoseat's own log | `~/.relay-autoseat/autoseat.log` (and `.err.log`) |

## FUTURE WORK - the Linux replacement, NOT BUILT

When this moves to Linux, the whole `.ps1` + `.vbs` + Scheduled Task supervision
stack collapses into **a single systemd unit** - a user service with
`Restart=always` (or a service plus a timer, if the 5-minute idempotent-poke
shape is kept). That also deletes, rather than ports, three of the problems
above: no CP-1252 script parsing, no console flash to suppress with a `.vbs`,
and no session-0 vs Interactive-logon question.

**This is a note, not a task. Do not build it.** It is recorded here so the
eventual port does not have to rediscover what the Scheduled Task was doing.

---

Back to the core manual: `SKILL.md`.
