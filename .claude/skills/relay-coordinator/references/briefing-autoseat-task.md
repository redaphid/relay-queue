# BRIEFING MATERIAL - autoseat Scheduled Task supervision

**This is material to PASTE INTO A SUBAGENT BRIEF. The coordinator does not run
any of it.** Every command below is `powershell` against Windows Task Scheduler,
which the coordinator guard denies outright (default-deny allowlist: only
`curl`/`wget` aimed at the relay, markdown writes, and inert inspection are
permitted). A coordinator that reads this and tries to act on it is refused.

Read when: you are about to dispatch an agent to check, install, restart or
disable auto-seating, and need to hand it the facts.

### It is supervised by a Scheduled Task. Do not start it by hand.

**`relay-autoseat` (Windows Task Scheduler) is what keeps it alive** — at logon, and again every 5 minutes forever. Check it, rather than assuming, before concluding auto-seating is armed:

```sh
powershell -NoProfile -Command "(Get-ScheduledTask relay-autoseat).State"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'autoseat\.js' } | Select ProcessId"
powershell -ExecutionPolicy Bypass -File tools\autoseat-install-task.ps1   # (re)install
```

`tools/autoseat-start.ps1` is the idempotent starter (**no-ops when a `node.exe` is already running `autoseat.js`**, which is what makes a 5-minute trigger a supervisor instead of a fork bomb); `tools/autoseat-start.vbs` only exists to suppress the console flash every tick would otherwise put on his desktop.

- **This was added because the supervisor used to be a person remembering.** The log shows autoseat watching continuously from `2026-08-28 00:50:36` to `2026-08-29 00:32:56`, then stopping mid-stream with an **empty `.err.log`** — no crash and no stack, just a parent terminal closing and taking the process with it. Twenty minutes later a human message sat in the Flux Pavilion tab for 14+ minutes with nobody seated: the exact failure autoseat exists to prevent, reintroduced one level up the stack. **A mechanism whose own liveness depends on a human is not a fix, it is a relocation of the same bug.**
- **The liveness check matches `node.exe` specifically, and that filter is load-bearing.** The start script's own path contains the string `autoseat`, and so does the `wscript`/`powershell` command line launching it, so a bare `CommandLine -match "autoseat"` finds *itself*, concludes autoseat is already up, and starts nothing — forever, while reporting success. A check that cannot return "no" is not a check.
- **Known limit, by choice:** an Interactive-logon task does not run while nobody is logged on. A locked screen is fine; a logged-out box means no auto-seating until he logs in. The alternative (S4U, as `OllamaProxySupervisor` uses) runs in session 0, and nothing here has established that `claude` authenticates correctly from session 0. **Test that before switching the LogonType**; do not just change it and assume.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
