# SSE streams - firehose, filtering, and the server's own backstop

Read when: you need the unscoped firehose on purpose, you are cutting redundant
wakeups on a busy tab, you are on an older build without `?conversation=`, or
you are checking whether the server's own stale-pending nudge already covers you.
The rules you can actually violate stay in the core manual under **Watch, don't poll**.

- Included in a scoped stream: task broadcasts (create/claim/result/relayed/progress/check-tick) and conversation broadcasts (create/patch) — anything carrying a `conversationId`.
- Excluded from a scoped stream: the global watch/deadman health tick and the initial connect-time snapshot — neither belongs to a single conversation, so they're dropped rather than guessed at.
- Shipped 2026-08-23, commit `aa9a87d`, tested by `tools/events-selftest.js` (stands up two conversations, proves a scoped stream gets only its own frames — verified to fail on the old unscoped code). Rollback: `git reset --hard pre-events-filter` (durable tag, not a bare SHA).

**The full, unscoped firehose — every event, every conversation — has its own dedicated URL:**

```sh
curl -s http://127.0.0.1:3901/events/firehose
```

Use this only if you genuinely need to watch everything at once. Today the one real consumer is `relay-watchdog` (a separate container watching the whole system for stuck/unanswered work). Two coordinators accidentally subscribed to the unscoped stream on 2026-08-23 and it cost real tokens — that is exactly the mistake this URL exists to make harder to make by accident: `/events/firehose` says what it is, instead of looking like the same convenient default as scoped `/events`.

Bare `GET /events` with no `?conversation=` still works today and is identical to `/events/firehose` — kept for backward compatibility because `relay-watchdog` depends on it right now. It may be locked down or changed later (no promised timeline). Don't build new things against the bare unscoped form; use `/events/firehose` if you mean the firehose on purpose, and scoped `/events?conversation=<id>` otherwise.

**If you only care about STATE (a task reaching its final answer), not every lifecycle transition, filter narrower than just conversationId.** A single checklist tick on an actively-worked conversation can produce a claim event, a progress event, a result event, and a relayed event — 4+ separate wakes for one logical change, each costing a turn even if you correctly no-op on the duplicates. For a consumer that only needs to know "this settled," filter for `"status":"done"` and `"relayed":true` together, or for checklist-sourced changes specifically, `"from":"checklist"`. This cuts the redundancy from ~4x down to ~1x on a busy conversation. Found on 2026-08-23 by a sync agent whose broad `"conversationId"` filter fixed its original never-fires bug but left this 4x-wakeup cost in place.

**If you're on an older build without the query param**, filter client-side in the pipeline itself, not after waking: `| grep --line-buffered '"conversationId":"<yours>"'`. Cost of getting this wrong is real — an unfiltered `| grep --line-buffered .` measured at ~100K tokens per wakeup just to conclude "not mine."

For container-level debugging: `docker logs -f relay-queue --since 1m 2>&1 | grep --line-buffered -E "ERROR|WARN"` (merge stderr with `2>&1` or failures go unseen).

**The server backs this up itself.** If a conversation has an assigned agent and a task sits `pending` (unclaimed) for more than 2 minutes, `nudgeStalePending()` (server.js, same `WATCH_TICK_MS` tick as the deadman banner) queues one short push through the same pipeline as `notifyWatchLevel`, e.g. `"1 unclaimed 3 min in <title>"`. Re-nudges at most every few minutes while it stays unclaimed, never every tick — not a substitute for arming your own watcher, it's the backstop for when that watcher died or was never armed.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
