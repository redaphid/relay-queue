# Checklists parsed out of message text (`/checklists`, PLURAL)

Read when: you are ticking, reading or reasoning about `- [ ]` items that live
inside a message or result body. For the editable pinned list, see
`checklist-tab-list.md` - they are different objects on different routes.

Any `- [ ]` / `- [x]` in a message or result body renders as real, tickable checkboxes — plain markdown, no special field.

- **Entry id is the thread entry, not the task.** `<taskId>` = the instruction side, `<taskId>:r` = the result side. A single task can carry two independent lists (one per side); the wrong id is not reliably a 404, it just ticks the other list. Resolve from where the text actually lives.
- `GET /tasks/<entryId>/checks`, `GET /checklists?conversation=<id>`, `GET /checklists?open=1`
- `POST /tasks/<entryId>/checks {"index":0,"on":true,"by":"..."}`
- Each item reports `source`: `"text"` (written that way) vs `"checked"` (actually tapped) — never conflate "the list says done" with "they said it's done".
- Index = ordinal of the task line in the message, skipping fenced code blocks.
- Never rewrite a message to fix a tick — the message text is truth for *what's on the list*, `check` events are truth for *what's ticked*; post a new message instead, which correctly starts unticked.
- A burst of taps settles into ONE notification after ~20s of quiet: a pending task in the conversation (`from:"checklist"`, `role:"user"` — this is what wakes you), plus a `checklist`-channel message (`GET /messages?channel=checklist&since=<iso>`), never one message per tap.
- Ticks before `2026-08-08T23:20Z` have no server record — the endpoint honestly reports "nothing ticked" for pre-cutover lists, which is a "no record" statement, not "not done".

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
