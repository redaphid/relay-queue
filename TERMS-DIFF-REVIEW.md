# Review: the uncommitted `server.js` working-tree diff

**Verdict: needs changes first — but only one of them is about the terms feature.**
The `POST /terms` work is good and close to commit-ready. The diff, however, is
**two features in one**, and the second one (`GET /openapi.json` / `.yaml`)
depends on three untracked files. Commit `server.js` as it stands and a fresh
clone will not boot.

Reviewed at 557 insertions / 9 deletions in `server.js`, plus untracked
`tools/terms-api-selftest.js`, `openapi-yaml.js`, `openapi.json`, `openapi.yaml`.

---

## Coherence — this is TWO changes, not one

They share nothing: no helper, no data, no route prefix. Split them.

1. **The dictionary over HTTP** — `server.js:3529-4197` and the route at
   `server.js:8362`. `TERMS_OVERLAY_FILE`, `termsStamp`, `readTermsFile`,
   `mergeTerms`, the rewritten `loadTerms`, `termsRaw`, `writeTermsOverlay`,
   `termsCounts`, `termsReadRoute`, `termsAddRoute`. Tested by
   `tools/terms-api-selftest.js`.
2. **The API description over HTTP** — `server.js:4739-4790` and the route at
   `server.js:8221`. `openapiDoc`, `sendOpenapi`, and a top-level
   `require('./openapi-yaml.js')`. Untested; the selftest it cites does not exist.

Piece 2 is roughly 60 of the 557 lines and carries every blocking problem below.

---

## Findings, most severe first

### 1. BLOCKER — `server.js:4760` requires a file that is not in git

```js
const openapiYaml = require('./openapi-yaml.js');
```

This is a **top-level require**, executed at module load, not inside the route
handler. `openapi-yaml.js`, `openapi.json` and `openapi.yaml` are all
**untracked** (`git status --porcelain` shows `??` for each; nothing in
`.gitignore` excludes them — `git check-ignore` returns nothing).

Committing `server.js` alone therefore ships a `server.js` that dies with
`MODULE_NOT_FOUND` before it binds a port. It also breaks every selftest,
because `tools/*-selftest.js` `require('../server.js')` directly.

It works right now only because the untracked files happen to exist in the
working tree the container bind-mounts.

**Fix:** `git add openapi-yaml.js openapi.json openapi.yaml` in the same commit,
or drop hunk 2 from the commit entirely.

### 2. BLOCKER-ish — the openapi feature cites a test that does not exist

`server.js:4753` and `openapi-yaml.js:24` both name `tools/openapi-selftest.js`
as the thing that keeps the hand-written spec honest — "it boots a real server,
proves every documented path+method actually routes, and scans this file for
route segments the document has never heard of". `ls tools/` has no such file.

So a 161 KB hand-written spec and a 173 KB derived YAML are being committed with
**zero** enforcement that either matches the server or each other, and the
comment asserts otherwise. Either write the selftest or delete the claim; a
comment that promises a guarantee nobody enforces is worse than no comment.

### 3. Real bug — an unreadable overlay is silently overwritten, losing every term ever added

`server.js:3647` swallows *every* read error, not just `ENOENT`:

```js
try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
```

`server.js:4097` then does:

```js
file = readTermsFile(TERMS_OVERLAY_FILE) || {};
```

The `try/catch` around it correctly answers **500** when the overlay is present
but malformed JSON — that path is well argued and well tested. But an overlay
that is present and *unreadable* (EACCES, EISDIR, EMFILE — plausible on the
NTFS bind mount this very diff worries about at `server.js:3634`) returns
`null`, becomes `{}`, and `writeTermsOverlay` at `server.js:4162` then **replaces
the whole file**. Every previously accepted term is gone, and the reply says
`ok: true`.

The 500 exists precisely to stop "it cannot be appended to safely" from turning
into a clobber. This second path walks around it.

**Fix:** in `readTermsFile`, rethrow anything whose `err.code !== 'ENOENT'`.
That also gives `loadTerms` a log line instead of silence (see finding 6).

### 4. Real bug — a POST silently deletes a hand-set `minPhoneticLength`

`mergeTerms` at `server.js:3705` explicitly honours `overlay.minPhoneticLength`,
and `TERMS_OVERLAY_README` tells the reader the file is "Safe to hand-edit".

But the read-modify-write only carries two keys forward —
`server.js:4102-4103` take `file.terms` and `file.protect` and nothing else —
and `writeTermsOverlay` at `server.js:3898` writes a fresh object:

```js
JSON.stringify({ _readme: TERMS_OVERLAY_README, terms, protect }, null, 2)
```

So any hand-added `minPhoneticLength` (and any other key) is dropped by the
next unrelated `POST /terms`, with no mention of it in the response. The one
overlay knob the merge supports is the one the write path destroys.

**Fix:** spread the parsed file — `{ ...file, _readme: …, terms, protect }` —
or stop honouring `overlay.minPhoneticLength` in `mergeTerms`. Either is fine;
supporting it in one direction only is not.

### 5. Input validation is looser than every other POST handler in this file

`termsAddRoute` (`server.js:3954`) does type checking well — better than most
routes here — but skips the two things this file is otherwise strict about:

- **No length caps.** Every other string field goes through
  `readString(raw, label, max)` (`server.js:6358`) against a `MAX_*` constant.
  `term`, each `heard` entry, `note`, `by` and each `protect` entry have none,
  and neither `heard` nor `protect` has an element-count cap. The only bound is
  `MAX_BODY` = 1 MiB (`server.js:46`). One POST can therefore park ~1 MiB of
  junk in the overlay, which is then re-parsed and re-indexed on every `/stt`
  call. `by` in particular should use the existing `MAX_AUTHOR`.
- **No `isDamaged()` check.** `createMessage` refuses text that already carries
  U+FFFD (`server.js:~6390`, documented at README:1368) on the grounds that
  those characters are lost before they arrive. `parseBodyBuffer` catches
  invalid UTF-8, but not valid UTF-8 that already contains replacement
  characters — and this route writes to a *config* file that is read forever
  after, which is a stronger case for refusing than a single message is.

Neither is exploitable from outside (the port is loopback-only), so this is
"tighten before commit", not a blocker.

### 6. Diagnosability regression in `loadTerms`

Old code: a `TERMS_FILE` that existed but would not parse logged
`transcript repair disabled: …`. New code (`server.js:3726`) reaches the same
disabled state through `if (!base)` with **no log line at all**, because
`readTermsFile` collapsed the read error into `null`. The comment on the branch
says "no dictionary: repair is a no-op", which is true for `ENOENT` and
misleading for everything else. Fixing finding 3 fixes this too.

### 7. Blast radius — this is NOT purely additive

Two pre-existing things are rewritten, both on the `/stt` path:

- `termsCache` changed shape (`server.js:3629`): `{ mtimeMs, index }` →
  `{ key, index, raw }`.
- `loadTerms` (`server.js:3713`) no longer reads `TERMS_FILE` and uses `raw`
  directly; it now runs the parsed document through `mergeTerms` first.

Consequences worth knowing before committing:

- `mergeTerms` **rebuilds** the `terms` array and keeps only `term`, `heard`
  and `note` (`server.js:3672-3688`). Any other per-entry field in
  `stt-terms.json` is dropped from the merged view. Harmless for the index
  (`server.js:3754` reads only `term` and `heard`), but `GET /terms` reports
  the merged array, so the `by` and `at` that `termsAddRoute` writes
  (`server.js:4141`, `4147`) are invisible in `terms:` and only visible in the
  separate `overlay:` block. Slightly surprising; worth a sentence of comment.
- `mergeTerms` also **de-duplicates by canonical spelling** — two entries with
  the same normalised `term` in `stt-terms.json` now collapse into one, where
  before the later silently won at `exact`. This is an improvement and the
  comment says so, but it is a behaviour change to a curated file, not an
  addition.

`tools/terms-selftest.js` (tracked) exercises `repairTranscript` through this
path, so it is the regression net — run it before committing.

### 8. `mergeTerms` note concatenation can duplicate on promotion

`server.js:3690`: `cur.note = cur.note ? \`${cur.note} ${note}\` : note`. If a
note is promoted into `stt-terms.json` **without** deleting the overlay entry,
the merged note contains it twice. The overlay README at `server.js:3884` says
promote-then-delete is a no-op, which is true; promote-*without*-delete is the
case that misbehaves, and it is the more likely human mistake.
`termsAddRoute` guards the same thing for POSTs via the `said.includes(note)`
check at `server.js:4136`, so the machinery to dedupe already exists — reuse it
in `mergeTerms`.

### 9. `openapiDoc` caches on mtime alone, contradicting this same diff

`server.js:4766`: `openapiCache.mtimeMs !== stat.mtimeMs`. `termsStamp`
(`server.js:3638`) exists specifically because "DATA_DIR is a bind mount off
NTFS, where mtime granularity is not something to bet the whole feature on".
`openapi.json` sits in the *code* mount, which is the same NTFS disk. Same
argument, opposite conclusion, sixty lines apart. Use `mtimeMs:size` here too.

### 10. `/terms` reports container paths where the rest of the server reports host paths

`termsReadRoute` (`server.js:3936-3937`) and every `termsAddRoute` reply return
`file` / `overlayFile` as the **container** spelling, `/app/data/…`. The image
routes deliberately translate through `HOST_DATA_DIR` (`server.js:5776-5792`)
because, per `docker-compose.yml`, "agents run on the host … handing them one
sent them to a file that, for them, does not exist". The one caller this route
was written for — a coordinator with only `curl` — is exactly the caller that
cannot open `/app/data/stt-terms.local.json`. Reuse the existing translation.

### 11. Minor

- `entry.by` is **replaced**, not appended (`server.js:4141`), while the
  adjacent comment block makes a careful argument for never replacing a `note`.
  Second contributor to a term erases the first one's name.
- The note-dedupe at `server.js:4136` is a substring test, so a new note that
  happens to be a substring of an existing one is silently reported
  `note: 'unchanged'`.
- `_readme` in the overlay is unconditionally overwritten on every write
  (`server.js:3898`), so a hand-edited readme does not survive. Probably
  intended; not stated.
- Concurrency: the "no `await` between read and rename" argument
  (`server.js:4088-4095`) is correct **within one process**. It does not hold
  across processes — a selftest instance and the container sharing a `DATA_DIR`
  can still lose an update. The atomic rename bounds the damage to a lost
  update rather than a torn file, which is the right trade; just don't read the
  comment as stronger than it is.

---

## Test coverage

**`tools/terms-api-selftest.js` is genuinely good** — the strongest part of this
changeset after the route itself.

- **It does not assume a running server.** It spawns its own via
  `startServer` from `tools/harness-lib.js` on an ephemeral port
  (`PORT || 0`), against a `mkdtemp` scratch dir, with `STT_TERMS_FILE` and
  `STT_TERMS_OVERLAY_FILE` pointed at fixtures. It explicitly asserts the real
  curated file is byte-identical afterwards. Safe to run at any time.
- **Two halves, correctly split**: over HTTP for the route contract, in-process
  against `repairTranscript` for "the overlay actually reaches the matcher" and
  the additive-only property. The in-process half requires `server.js` *after*
  setting the env, which is the right call and is explained.
- ~80 checks including all 21 refusal cases, `changed: false` on a replay,
  no duplicate entry, no leftover `.part` file, and a regression fixture for
  the real 2026-09-02 `"openapi spec"` hole that motivated `wrapsTerm`.

Gaps: no coverage of the **503** when the curated dictionary is missing, the
**500** invalid-overlay-on-write path, findings 3/4/5 above, or the
`openapi.json` / `openapi.yaml` routes at all. Also, nothing wires this into a
runner — `README.md:290-326` lists selftests by hand, and neither
`terms-api-selftest.js` nor an openapi selftest is in that list yet.

---

## What to do before committing

1. `git add openapi-yaml.js openapi.json openapi.yaml` **or** drop the openapi
   hunks. Do not commit `server.js` with hunk 2 and without those files.
2. Rethrow non-`ENOENT` in `readTermsFile` (findings 3 and 6).
3. Preserve unknown overlay keys on write, or stop reading
   `overlay.minPhoneticLength` (finding 4).
4. Add length caps and an `isDamaged` check to `termsAddRoute` (finding 5).
5. Run `node tools/terms-selftest.js` and `node tools/terms-api-selftest.js`.
6. Add both new selftests and `/terms` + `/openapi.json` to the README's
   route and testing sections.

With 1-4 done, this is a clean commit. Split as two:

---

## Suggested commit messages

**Commit 1 — the terms feature** (`server.js` terms hunks, route at :8362,
`tools/terms-api-selftest.js`, README):

```
Let an agent with only curl fix a mishearing it just watched happen

The people best placed to notice a bad transcription are the ones who
cannot fix it: the coordinator guard denies every write but markdown and
denies node/python/sed -i, so a curl at this server is the only channel
left. GET /terms reads the vocabulary dictionary and POST /terms appends
to it.

Additions land in an overlay in DATA_DIR, not in stt-terms.json, which is
bind-mounted read-only and stays the curated human-edited artifact. The
merge is additive only, so nothing posted at the API can delete a heard
form, unprotect a word or overwrite a note he wrote down deliberately.

Every refusal is a form that would otherwise be stored and then silently
ignored - a form equal to its own term, one that wraps it and would eat
the surrounding words, one longer than any span repair tests, one already
owned by another term. tools/terms-api-selftest.js spawns a real server
against fixtures and covers all of them, including the "openapi spec"
posting that found the wrapping hole.
```

**Commit 2 — the openapi feature** (`server.js:4739-4790` and `:8221`,
`openapi-yaml.js`, `openapi.json`, `openapi.yaml`, and the selftest it claims):

```
Serve the API description from disk, with the YAML rendered from the JSON

GET /openapi.json and GET /openapi.yaml. openapi.json is the authored
document; the YAML is rendered on every request by openapi-yaml.js rather
than read from the checked-in copy, so the two cannot disagree no matter
how stale that copy gets. Cached on mtime like the service worker, so a
fresh mount is picked up without a restart.

Hand-written because the routes are hand-written - see /v2 for the
generated alternative, which covers 5 of them.
```
