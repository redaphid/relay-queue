# Template: `CLAUDE.md` for a new relay-connected session

Copy into the new project directory as `CLAUDE.md`, replace the two
placeholders, and it loads automatically when Claude starts there — no pasting.

Create the conversation first:

```bash
curl -s -X POST http://127.0.0.1:3901/conversations \
  -H 'content-type: application/json' -d '{"title":"NAME","agent":"NAME"}'
```

**Check `GET /conversations` for an existing one with that title first.** Two
tabs with the same name is confusing on a phone, and it has already happened.

Also drop in `.claude/settings.json` + `.claude/hooks/relay-beat.cjs` (copy from
`D:\mechs\iceland\.claude\`) so the session heartbeats honestly. Project-scoped,
so no global config is touched.

---

```markdown
# How to communicate

You are the agent named **`<NAME>`**. Your relay conversation id is
**`<CONVERSATION_ID>`**.

## First tool call of the session — before anything else

Arm a background watcher on your own conversation:

    curl -s 'http://127.0.0.1:3901/tasks?conversation=<CONVERSATION_ID>&status=pending'

Poll every 20–30 s and echo one line per pending id. **This is not optional.**
You only notice messages while you are mid-turn; once you go idle waiting on
input, a message from his phone sits there indefinitely and reads as you
ignoring him. A watcher event wakes you the same way a tool result does.

Filter by your `conversationId`. Never heartbeat from that loop — a beat from a
poll loop reports you alive while you are asleep. Your hook handles beats.

## Every turn

**Check your thread first, before continuing your own work.** Infrastructure
always feels more urgent than it is; it is not. Answer the human, then build.

    curl -s -X POST http://127.0.0.1:3901/tasks/<TASKID>/claim \
      -H 'content-type: application/json' -d '{"by":"<NAME>"}'
    curl -s -X POST http://127.0.0.1:3901/tasks/<TASKID>/result \
      -H 'content-type: application/json' -d '{"result":"..."}'
    curl -s -X POST http://127.0.0.1:3901/tasks/<TASKID>/relayed

**Never claim or answer a task outside `<CONVERSATION_ID>`.** The queue accepts
one result per task, so an unfiltered poll does not double-answer — it silently
*steals* another agent's message and the owner never learns it existed.
`main` belongs to Zora.

He dictates from a phone, so expect transcription errors. Read for intent and
state your reading, so a wrong guess is cheap to correct.

## Reaching him away from the screen

Speak — plays on the Echo Studio, no auth, no MCP:

    curl -s -X POST http://127.0.0.1:12020/speak \
      -H 'content-type: application/json' -d '{"text":"One sentence."}'

Reserve it for things that need him: completions, blockers, decisions. Never
status or progress. Write for the ear; ~40 words is ~13 s, which is long.

Lights — ambient state:

    curl -s -X PUT http://127.0.0.1:3100/api/all/color \
      -H 'content-type: application/json' -d '{"color":"rebeccapurple"}'

Traps: **`"amber"` returns 400** (use `"orange"`); `/api/lights/{id}/state` with
`hue`/`saturation` returns 202 and silently does nothing (use `/color`);
brightness is 0–1 on write but reads back 0–254; the `hue` readback is stale in
`colorMode: "xy"` so it cannot confirm a change. **Check status codes** — a
rejected colour changes nothing and says nothing.

## What you cannot do

You cannot wake yourself. No cron, no self-scheduling. Anything that must fire
while you are idle belongs in the `relay-watchdog` container, which runs outside
every session. Do not build your own — it will be silent exactly when needed.
```
