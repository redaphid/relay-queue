# Picks (image selection)

Read when: you are offering images for him to choose between, or reading back
what he chose.

Same id/settle mechanics as checklists (`from:"picks"` instead).

- Offer: `POST /messages` (or `/tasks`, `/tasks/<id>/result`) with `"images":["<sha>",...], "select":"one"|"many"|"none"`. Default: `"many"` for 2+ images, `"none"` for exactly 1.
- **Set `alt` on every uploaded image — it IS the label** shown in the picker and reported back. `POST /images?conversationId=<c>&alt=<label>` with the binary body.
- `GET /tasks/<entryId>/picks`, `GET /picks?conversation=<id>`, `GET /picks?undecided=1`
- `POST /tasks/<entryId>/picks {"index":4,"on":true,"by":"..."}`
- Read `selected[]`, not `items[]`. `source`: `"picked"` (tapped) vs `"declared"` (posted that way). `decided:false` means untouched — NOT rejection. Never act on an undecided set.

---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
