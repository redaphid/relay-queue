# NEVER EXECUTED - pre-dispatch mindmeld summary of a long tab

## Status: written, measured, and structurally impossible for its intended reader

**This procedure has never run, and as written a coordinator cannot run it.**
Preserved verbatim and unaltered, pending the human's decision. Do not delete
it - deleting protocol is his call, not an agent's.

Two independent blockers, both checked on 2026-08-29:

- **`data/summaries/` has never been created.** Not on disk under
  `D:\projects\relay-queue\data\`, and `git log --all -- data/summaries`
  returns nothing. The final step of this procedure has never been performed.
- **The coordinator guard denies the network call the procedure requires.**
  `coordinator-guard.js` permits `curl`/`wget` only against
  `http://127.0.0.1:3901` (also `localhost` / `[::1]`, port 3901 only). A `curl`
  at `http://localhost:3847` is refused with rule `net-offrelay`. The same rule
  denies the Ollama gate on `:11436`. So the prescribed action is not merely
  unperformed - it is unavailable to the reader it was written for.

**For the human to decide:** delete it, rewrite it as briefing material for a
dispatched subagent (subagents are guard-exempt and could do this), or widen
the guard. Until then it stays here, where nobody reads it by accident.

---

### Before dispatching into a long existing tab, check mindmeld first

Every agent sent into a tab pays the same boot tax: this file, **48 KB / ~12k tokens**, plus the whole thread it is being asked to catch up on. Three coordinators overlapped in the Flux Pavilion tab on 2026-08-29 (`FluxPrep`, `FluxPrep2`, `auto-flux-pavilion-show-abxx`) and the human asked, fairly, *"How could what we are doing possibly take 70k tokens?"* The answer in the thread was *"boot tax, paid 3 times"* — almost none of it was his to-do list.

**Only take this detour for a long thread.** Re-measured on the 31-message tab that provoked it: **17,181 bytes** of JSON, **~554 bytes (~140 tokens) per message**. A thread has to run into the dozens before its own read cost rivals this file's fixed cost. **~20 messages is a starting point, not a benchmarked cutoff** — it rests on that single data point, and `GET /conversations` already returns the `messages` count you would test it against.

- **Mindmeld answers plain HTTP with no auth at `http://localhost:3847`, and the route is `GET /api/search`** — bare `/search` returns 404. Required `q`; useful: `mode=text` (fastest, reads Postgres directly and needs no embeddings), `limit`, `dataClass`, `since`, `cwd`.
- **`dataClass` defaults to `coding`, and that default is already correct here.** A relay coordinator *is* a Claude Code session on this box, indexed like any other: `source:"claude_code"`, `dataClass:"coding"`. No special filter is needed — confirmed by a live default search returning real coordinator sessions.
- **Two gaps, so nobody over-trusts this.** (1) **No field ties a mindmeld session to a relay `conversationId`.** You search by content and infer, and one tab can be several sessions — Flux Pavilion was three, held as three unlinked records, not one history. (2) **A session that ended less than 30 minutes ago is excluded from summarization on both sides** (`mind-meld/CLAUDE.md:124`). So **this does nothing for the hot tab you are being dispatched into right now**; it helps only for a tab that has already gone quiet.
- **If it is not indexed, or is too fresh, summarize the raw thread with local Ollama:** model **`qwen3:4b-instruct`** — note the exact tag, plain `qwen3:4b` is *not* pulled on this machine — and send it **through the gate on `:11436`, never real Ollama on `:11434`**. This adds no new dependency: mindmeld's own summarizer already runs exactly that model through exactly that gate (`SUMMARIZE_MODEL=qwen3:4b-instruct`, `OLLAMA_URL=http://host.docker.internal:11436`). **Measured 2026-08-29: HTTP 200 in 8s from cold.**
- **Bound the call and fail open.** One stuck client can starve Ollama's single generate slot, and a resident VLM can collapse GPU work to a crawl. Time out and fall back to a raw-thread read — a summarizer that hangs is worse than one that never ran.
- Write the result to **`data/summaries/<conversationId>.md`**. All of `data/` is gitignored already (`git check-ignore` confirms), so a generated summary can never reach git history.


---

Back to the core manual: `D:\projects\relay-queue\.claude\skills\relay-coordinator\SKILL.md`.
