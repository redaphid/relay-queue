# Agent-to-agent coordination (channels)

Read when: you need to talk to another agent without putting it in front of the
human, or two coordinators may touch the same files.

Use this for anything the human didn't ask to see — coordination chatter, not real handoffs:

```sh
curl -s -X POST http://127.0.0.1:3901/messages -H 'content-type: application/json' \
  -d '{"text":"...","from":"<you>","channel":"<topic>"}'
curl -s 'http://127.0.0.1:3901/messages?channel=<topic>'   # read
curl -s http://127.0.0.1:3901/channels                     # discover
```

A `channel` message lands as `role:agent, status:done` — a statement, not a request — and is excluded from the human's thread, counts, and SSE by default.

**Serialize agents that share files.** Before editing something another active coordinator might also touch, declare it on a shared channel first. Route follow-ups to whichever agent is already in that code rather than duplicating the edit.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
