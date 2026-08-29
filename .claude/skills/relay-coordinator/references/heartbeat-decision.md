# Decision record - do not build an external heartbeat

Read when: someone proposes pinging relay on a schedule to "keep it alive", or
asks why `Monitor` does not revive a dead coordinator. This is a settled
decision, recorded so nobody builds it twice.

### Don't build an external heartbeat. Relay already ticks on its own.

**Asked on 2026-08-29 — "can Vikunja, or anything, ping relay every 5 minutes to keep it alive?" It would accomplish nothing.** Recorded so nobody builds it twice, with the measurements re-taken the day this was written:

- **Relay's self-maintenance does not depend on external traffic at all.** `WATCH_TICK_MS` defaults to **15000** (`server.js:3044`), and `setInterval(pushWatch, WATCH_TICK_MS).unref()` (`server.js:8056`) runs `sweepVacantChairs()` and then `nudgeStalePending()` in sequence on every tick (`server.js:3365-3366`). A 5-minute external ping is **20x less frequent than what already happens by itself**, and would not make either function run any more or less often.
- **Nothing here is at risk of being reaped for idleness.** The server is a plain long-lived `node server.js` process on the host, not a scale-to-zero container, so there is no "keep it warm" case either.
- **The nearest thing to a scheduled poke already runs, and is narrower than it looks.** The `vikunja-reminders` container (`node:22-alpine`, `/app/reminders.js`, bind-mounted from `D:\projects\vikunja\reminders`) polls every `POLL_INTERVAL_SECONDS=60` and, when a reminder comes due, POSTs straight into relay `/messages` (`reminders.js:223`). But it targets **one hardcoded `RELAY_CONVERSATION_ID`** (`mtazdjld-rsrxl9`), not "whichever tab needs waking". A repeating Vikunja task buys you that cadence into that one tab, and nothing else. (Vikunja reports `"webhooks_enabled":true` on `GET /api/v1/info`; the event list itself needs an auth token to read, so treat any specific event name you have not personally confirmed as hearsay.)

**The distinction the whole 2026-08-28/29 session turned on:** *keeping a live coordinator awake* and *reviving a dead one* are different problems. `Monitor` solves the first and does **nothing** for the second — it dies with the process that armed it, so a one-shot subagent that has already returned took its own watcher down with it. Reviving is what **Auto-seat** below is for, and it needs no `Monitor` at all.

---

Back to the core manual: `SKILL.md`.
