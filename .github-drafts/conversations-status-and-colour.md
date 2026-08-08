# Conversations, status and colour — what shipped, what is left

**Labels:** `feature`, `ui`, `api`
**Related:** `two-way-voice-conversation.md`

## What shipped

- **Conversations.** Every task carries a `conversationId`, defaulting to `main`. `/conversations`
  lists, creates, renames, reassigns and archives; `/thread`, `/tasks` and `/results` take a
  `conversation=` filter. The default conversation is created in memory and never written, so an
  older `events.jsonl` replays byte for byte. `tools/replay-selftest.js` proves it.
- **Hamburger menu.** Conversation list with last message, time, counts, a 3-hour sparkline, the
  owning agent and its liveness. Per-conversation hue derived from the id.
- **`/status` and `/heartbeat`.** Answers "is anything listening?" with a plain-words headline.
  Strong evidence (claims and results) is separated from weak (heartbeats), and health is judged by
  how long nothing has happened *while work is waiting* rather than by raw silence.
- **Colour.** Two palettes kept apart: a playful per-conversation hue plus rainbow accents, and a
  fixed semantic palette for lifecycle and trouble.

## Scoped and deliberately not built

**1. Deleting a conversation.** Only archiving exists. Deletion would mean either rewriting the
append-only log or leaving orphaned tasks, and neither is worth it for a queue this size.

**2. Renaming from the UI.** `POST /conversations/:id` supports it; the page has no affordance yet.
The drawer needs a long-press or an edit icon, and neither is obvious on a phone.

**3. Per-conversation unread counts vs. the dot.** The menu shows a single dot for "something
arrived". A precise unread count per conversation would need the page to track what has been *seen*,
which is a real piece of client state that does not exist yet.

**4. Restart count on the status page.** Deliberately skipped: deriving it needs either a new state
file or a `boot` event in the durable log, and the log is for queue history. `uptimeSec` plus a note
that restarts are normal covers the actual need.

**5. Sparkline window is fixed** at 12 × 15 min. No zoom, no per-conversation window. It answers
"busy, quiet or dead" and nothing more, on purpose.

**6. Per-conversation `stuck` detection uses the whole conversation's last action.** If one agent
owns several conversations, its liveness is computed per conversation from that conversation's
claims and results — which is right — but there is no global "this agent is wedged everywhere" view.

**7. Colour has not been checked on a real device in bright sunlight**, and the contrast figures are
reasoned rather than measured with a tool. Worth a pass with an actual contrast checker.

**8. Cross-conversation claim protection is documentation, not enforcement.** The README states the
rule plainly and shows the scoped poll, but nothing stops an agent claiming a task outside its
conversation. Enforcement would mean an agent identity on claim (e.g. rejecting a claim when
`by` does not match the conversation's `agent`). That is a real option and was not taken because it
would break existing unauthenticated curl usage.

## Acceptance criteria for calling this done

- [ ] Two coordinators run for a day without either claiming the other's messages.
- [ ] The status page correctly calls out a genuinely hung agent, observed in the wild at least once.
- [ ] Contrast measured, not estimated, in both themes.
- [ ] A decision recorded on enforcing conversation ownership at claim time.
