# The tab list (`/checklist`, SINGULAR) - the pinned, editable list

Read when: a list needs to keep changing (add, reword, reorder, import), or he
is looking at a pinned list above the thread. For lists parsed out of immutable
message text, see `checklists-in-messages.md`.

**One editable list per conversation, pinned above the thread.** Different object from the one in `checklists-in-messages.md` — that one is parsed out of immutable message text, this one you can change without losing ticks. **Singular route: `/checklist`. The plural `/checklists` is the other thing.**

**Reach for this when a list needs to keep changing.** The message version cannot: its ticks are keyed to the ordinal of a line, so inserting an item slides every tick below it onto the wrong task. That is why Chores accumulated **16 lists with open items, 44 open items, nine of them single-item lists, and the same laundry list posted twice at different lengths.** Adding one chore and keeping the ticks was impossible, so coordinators posted another list. Do not add a seventeenth — put it here.

- `GET /checklist?conversation=<id>` — `list: null` when there is none. Null and "an empty list" are different answers.
- `POST /checklist {"conversationId":"...","by":"You","title":"Tonight","add":["..."],"edit":[{"id":"...","text":"..."}],"remove":["id"],"importFrom":"<entryId>","clearDone":true}` — every operation named; nothing is replaced wholesale by accident.
- `POST /checklist/tick {"conversationId":"...","id":"<itemId>","on":true,"by":"..."}` — **by item id, never by index.** Idempotent by value.
- **Items are addressed by `id`, minted once at creation.** Reorder, reword and insert are all safe. Never address an item by its position.
- **A tick survives an edit, deliberately.** Dropping it would silently un-tick finished work when someone fixes a typo, which is what drove the fragmentation. The wording that was ticked is kept in `tickedText` and the payload reports `editedSinceTicked`, so a tick earned against different words is visible rather than quietly inherited.
- **`importFrom` absorbs an existing message checklist**: open items only — ticked ones are finished and copying them would put completed work back in front of him. Re-importing does not duplicate. The source message is untouched (it is history) but now reports `supersededBy`, so the old list points at its successor instead of competing with it.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
