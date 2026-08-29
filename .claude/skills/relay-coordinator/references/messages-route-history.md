# Why `GET /messages` selectors are now refused rather than silently dropped

Read when: a read-back disagrees with a conversation's `messages` count, you
got a `400`/`404` from `GET /messages`, or you are about to conclude your own
write failed. The rules stay in the core manual under **Reading messages back**.

- **This route used to lie, and the shape recurs, so it is worth knowing how.** Before 2026-08-27 the GET understood only `channel`. `?conversationId=<tab>` was not rejected — the word was silently dropped and you got the **global `#agents` channel**, byte for byte the same reply as `GET /messages` with no query string at all. On 2026-08-27 an agent used it to confirm its own post, got **33 rows for a tab whose conversation object said 53**, none of them its own, and a `since=` window it had definitely written into came back **0**. It reported its write as failed. The write had succeeded. Same defect class as the attach route returning `200` with the seat unfilled: a **success shape over an answer to a different question**. A selector this route cannot honour is now refused — both selectors at once is `400`, an unknown conversation is `404` — never dropped.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
