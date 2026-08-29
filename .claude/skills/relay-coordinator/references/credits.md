# Credits - the 1-credit-per-feature economy

Read when: you are about to implement a feature (you must spend a credit
first, and decline at balance 0), or you are awarding credits for chores.

A flat 1-credit-per-feature economy: a "Chores" coordinator awards credits at its own discretion for genuinely significant real-world completions (e.g. "litter box fully cleared"); any coordinator must spend exactly 1 credit before implementing a feature (any size, no scaling by complexity), and must decline and tell the human to do more chores first if the balance is 0.

**This supersedes the original convention** of `POST /messages {"channel":"credits"}` with the latest message's free text parsed as a running balance. That was fragile: two coordinators could race a read-then-post-decremented-value cycle and silently lose an award or a spend, there was no structured amount/reason field, and there was no audit trail beyond scrolling the channel. The channel still exists and its history is preserved, but new reads/writes should use this API, not `?channel=credits`.

| action | call |
|---|---|
| check balance + history | `GET /credits` (optional `?limit=N` caps history to the most recent N; omitted = everything kept in memory, capped at 200 — the log itself keeps every entry regardless) |
| award | `POST /credits/award {"amount":N,"reason":"...","by":"..."}` — `amount` must be a positive integer; `reason` is required |
| spend | `POST /credits/spend {"reason":"...","by":"..."}` — always decrements by exactly 1; there is no `amount` field, because the cost is flat and not the caller's to choose |

`GET /credits` responds `{"balance":N,"history":[{"amount":N,"reason":"...","by":"...","at":"..."}, ...]}`, oldest first. A spend's `amount` is recorded as `-1`.

**Spend is refused with `402`, carrying the current balance, if the balance is below 1** — `{"error":"insufficient credits: ...","balance":0}`. This is the caller's cue to tell the human to do more chores, not to retry.

**Atomicity.** Event-sourced like everything else here (`t:"creditsAward"` / `t:"creditsSpend"` in `data/events.jsonl`, replayed into `creditsBalance`/`creditsHistory` in memory on boot) — a restart never loses the balance. The spend race (two coordinators calling spend at once when balance is exactly 1) cannot both succeed: the balance check and the `appendEvent` call that acts on it run synchronously in one turn of Node's event loop, with no `await` in between, so no other request can interleave. Verified in `tools/credits-selftest.js` by firing two real concurrent HTTP `POST /credits/spend` calls at balance=1 and asserting exactly one gets `200` and the balance settles at `0`, never negative — and by deliberately breaking that guarantee (inserting an `await` between the check and the write) to confirm the test actually goes red, not just green by construction.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
