# Why a conversation patch answers 409 instead of a silently-undone 200

Read when: you hit a `409` on `POST /conversations/<id>` and want to know
whether to retry, or you are tempted to trust a `200` that did not change
anything. The rule itself stays in the core manual under **Conversations**.

This exists because it used to return **`200` with the full conversation object and the write silently undone inside it**: on 2026-08-27 attaching a coordinator to a tab that had been quiet for an hour came back `200` with `agent: null`, twice, and the wrong conclusion drawn from it ("this tab is somehow special") survived several confirming GETs. `updateConversation()` re-reads the stored record after writing and refuses rather than serialising a record that does not match the request.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
