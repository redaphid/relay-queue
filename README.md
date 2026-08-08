# relay-queue

A minimal, durable, **local-only** HTTP message queue with a mobile web UI.

It carries messages between a **human** and their **agents**. The human types into the web UI on
a phone; an agent claims the message, does the work, and posts a result, which appears back in
the thread. It is also still the agent-to-agent hand-off channel it started as — a **Communicator**
(posts tasks, reads results back) and a **Coordinator** (claims tasks, posts results) — so that
nothing is lost while long background work is running. The agent side is driven by hand with `curl`.

- **Zero runtime dependencies.** Node built-ins only (`node:http`). No npm install, no `node_modules`.
  The UI is one self-contained HTML file — inline CSS and JS, no frameworks, no CDN, no external requests.
- **Durable.** Every mutation is appended to `data/events.jsonl` and fsynced *before* the HTTP
  response is sent, then replayed into memory on boot. A crash right after a `200` cannot lose a write.
- **Local.** Bare Node binds `127.0.0.1`. The container currently publishes `3901` on **all**
  interfaces, so it is reachable from the LAN — see the warning below.
- **No auth**, no priorities, no TLS. Put it behind an authenticating proxy before exposing it.

> **Right now anyone on this LAN can read and post to the queue.** The plan is to reach it over an
> HTTPS hostname fronted by Cloudflare Access; that also happens to be what the microphone needs, as
> browsers only grant it to secure pages. See `.github-drafts/https-for-mic-access.md`.

Web UI: **http://127.0.0.1:3901/** &nbsp;&nbsp; API base: **http://127.0.0.1:3901**

Voice is two-way: talk to it hands-free and hear the replies. See
[Conversation mode](#the-web-ui), [Speech to text](#speech-to-text), [Text to speech](#text-to-speech)
and [Why it cannot hear itself](#why-it-cannot-hear-itself).

---

## The web UI

Open **http://127.0.0.1:3901/** — one page, no build step, no login.

What you see, top to bottom: a `relay` header (which grows an `offline — retrying` note if the
server goes away, and holds the **speaker** toggle for spoken replies), the message thread, a status
line that appears while voice is in use, then a **mic** button, a **conversation** button, a textarea
and a **Send** button pinned to the bottom.

- **The thread** runs oldest at the top, newest at the bottom, and auto-scrolls to the bottom on
  load and whenever something new arrives. If you have scrolled up to read history it leaves you
  where you are instead of yanking you down.
- **Your messages** are right-aligned and blue, with a relative time (`now`, `7m`, `3h`, `2d`) and a
  status marker: `pending` (nobody has picked it up), `claimed` (an agent is working on it), or
  `answered` (the reply is below it). Tap-and-hold the time to see the exact timestamp.
- **Agent replies** are left-aligned in a bordered bubble, directly under the message they answer.
- **Sending**: tap **Send**, or press **Enter**. **Shift+Enter** inserts a newline instead, and
  **Ctrl+Enter** / **Cmd+Enter** still sends. The box only clears once the server has accepted the
  message; if the send fails your text stays put and a one-line reason appears above the composer.
  Messages are capped at 8000 characters.
- **Dictation**: tap the **mic** and talk. It measures the room for a moment, listens, and when you
  stop talking for about 1.2 s it stops by itself, transcribes what you said, and sends it — no
  second tap. Tap the mic again to cut it short (or to cancel before you have said anything). The
  transcript is appended to whatever is already in the box, so a half-typed draft is never lost, and
  it is sent through the ordinary send path with `from:"voice"`, which means a failed send leaves the
  words sitting in the composer exactly like a typed one. Audio never leaves the machine: it goes to
  [`POST /stt`](#speech-to-text), which relays it to a local Whisper engine.
  **The microphone only works on a secure page** — an `https://` origin, or `http://localhost:3901`
  on the machine itself. Browsers withhold the microphone from plain-http pages entirely, so over a
  LAN address the mic **cannot** work. When that is the case the mic button is drawn struck through
  and dashed, and tapping it puts up a message — which stays until you dismiss it — naming the
  reason, saying the mic itself is fine, and giving the URL that does work today. Permission denied,
  no microphone, a mic held by another app, and a transcription failure each say something different,
  because "try again" means a different thing in each case. All of them are also reported to
  `POST /client-log`, so a failure on a phone is diagnosable from `docker logs relay-queue` without
  anyone reading a console.
- **Conversation mode**: tap the **speech-bubble** button next to the mic and just talk. Unlike the
  one-shot mic, it does not stop after one message — it listens, detects the end of each utterance,
  posts it, and is listening again before the transcript has even come back, indefinitely, until you
  turn it off. The status line under the thread always says which of **listening / transcribing /
  speaking / paused** it is in, and the **Stop** button beside it (and a second tap on the button)
  ends it instantly: the queue is dropped, playback is cut and the microphone is released in the
  same tick, so the browser's recording indicator goes out immediately.
  Speaking again while the previous sentence is still being transcribed does not lose it — utterances
  queue up and are posted **in the order they were spoken**. Silence is fine and expected: a
  conversation never times out, it just re-measures the room every 10 s and keeps waiting.
  Messages from it are tagged `from:"voice-conversation"`.
  **Nothing worthless reaches the queue.** Empty transcripts, punctuation-only transcripts, sounds
  shorter than 350 ms, and the small set of phrases Whisper `tiny-int8` is known to hallucinate on
  near-silence (`thank you`, `you`, `thanks for watching`, `[BLANK_AUDIO]`, …) are all dropped, with
  a one-line note in the status bar saying so. `okay`, `yes` and `no` are deliberately **not**
  filtered: they are rarely hallucinated and are perfectly good things to say to an agent.
- **Spoken replies**: the **speaker** button in the header reads agent replies aloud through
  [`POST /tts`](#text-to-speech). It is **independent of the microphone** — it works on the plain-http
  LAN page where the mic cannot, and muting it never touches dictation. Turning on conversation mode
  turns it on too (the first time); after that your choice is remembered. Replies already in the
  thread when the page opens are never read aloud — only ones that arrive while you are watching.
  Agent replies are condensed before being spoken, on the rule **say what it is, not what it says**:
  URLs become "a link", fenced code becomes "a code block", shell commands "a command", file paths
  "a file path", long hashes and ids "a long identifier", and markdown furniture and emoji are
  dropped. The exact characters are on screen where they can be read and copied; nobody needs
  `https://` spelled out one character at a time. Anything over 900 characters is cut at a sentence
  boundary with "…that is the first part. The rest is on screen."
- **The microphone cannot hear the speaker.** This is the one thing in the voice feature that would
  be catastrophic to get wrong — a page that transcribes its own spoken reply posts it as a new
  message, gets another reply, and loops forever into a queue that agents act on. See
  [Why it cannot hear itself](#why-it-cannot-hear-itself).
- **Focus follows the window** on desktop: switching to the tab puts the cursor in the composer so
  you can just type. It is deliberately **not** done on touch devices — focusing a textarea there
  raises the on-screen keyboard, and having that happen on every app switch is intolerable. It also
  never steals focus from another field, from selected text you are copying, or mid-dictation.
- **Newlines and whitespace are preserved** exactly. Message text is written with `textContent`,
  never `innerHTML`, so a message containing HTML or `<script>` is displayed literally as text and
  cannot execute.
- **Updates are pushed live.** The page holds a `GET /events` stream open and the server sends every
  change down it the moment that change is durable, so a message typed on your phone appears on the
  laptop instantly, and an agent's reply lands without waiting for a poll.
  Polling did not go away — it is the fallback. While the stream is healthy the page still re-reads
  `GET /thread?since=…` every ~30 s as a repair pass; if the stream drops (or a proxy eats it) that
  drops back to ~3 s automatically and the page behaves exactly as it did before. Polling pauses
  while the tab is hidden, backs off up to 20 s if the server is unreachable, and recovers on its
  own — the page survives the service restarting under it without a reload. Nothing you have typed
  is ever overwritten by a refresh.
- **Mobile-first**: 16 px minimum text (so iOS does not zoom on focus), 48 px tap targets, no
  horizontal scroll, safe-area padding, and it follows your system light/dark setting.

The page contains **no secrets and no absolute URLs** — every request is root-relative (`/tasks`,
`/thread`), so it works unchanged behind a path-preserving reverse proxy on another hostname. It is
served with `content-security-policy: default-src 'none'; … connect-src 'self'`, which forbids the
page from making any external request at all.

The page lives at **`public/index.html`** and is read from disk on request (re-read when its mtime
changes, so editing it needs no restart — just reload the page, in the container too). The server
looks for it at `$UI_FILE`, then `public/index.html`, then `<DATA_DIR>/ui/index.html`, and logs which
one it picked at boot. `GET /` answers `503` with the list of paths it searched if it finds none.

> **Docker note:** compose bind-mounts the **whole repo** read-only at `/app` (with `data/` remounted
> writable on top), so the container serves the working-tree `public/index.html` directly. The old
> `cp public/index.html data/ui/index.html` copy step is **gone** — `data/ui/` is no longer used or
> needed. Mounting the directory rather than individual files is deliberate: git replaces a file by
> renaming a new one over it, and a single-file bind mount stays pinned to the original inode, so a
> pulled change would never be visible inside the container.

---

## Start it

### Option A — Docker (the normal way)

```bash
cd /d/projects/relay-queue && docker compose up -d
```

Uses the stock `node:22-alpine` image with the repo bind-mounted read-only at `/app` — there is no
image to build. Container name is `relay-queue`, `restart: unless-stopped`, so it comes back with
Docker Desktop. `data/` is remounted writable on top, pointing at `D:/projects/relay-queue/data`, the
same directory bare Node uses.

This also brings up **`relay-queue-sync`**, a tiny `alpine/git` sidecar that fast-forwards the
checkout from `origin/main` every 60 s — see [Staying up to date](#staying-up-to-date). It idles
harmlessly while there is no `origin`.

```bash
docker compose logs -f relay-queue    # follow logs
docker restart relay-queue            # restart (queue survives)
docker compose down                   # stop and remove
```

### Option B — bare Node (fallback, identical behaviour)

```bash
node D:\projects\relay-queue\server.js
```

Stop the container first, or the port will be taken. Both paths read and write the same
`data/events.jsonl`, but **do not run both at once** — two writers appending to one log will
interleave and each process only sees its own in-memory state.

### Configuration

| Env var         | Default        | Notes                                               |
| --------------- | -------------- | --------------------------------------------------- |
| `PORT`          | `3901`         |                                                      |
| `HOST`          | `127.0.0.1`    | The container sets `0.0.0.0`.                        |
| `DATA_DIR`      | `<repo>/data`  | Where `events.jsonl` lives.                          |
| `UI_FILE`       | —              | Overrides where the page is read from.               |
| `STT_HOST`      | `127.0.0.1`    | Wyoming ASR engine. The container sets `host.docker.internal`, since from inside it loopback is not the host. |
| `STT_PORT`      | `10300`        | wyoming-whisper's default port.                      |
| `STT_LANGUAGE`  | —              | Forces a language; unset uses whatever the engine is configured for. |
| `TTS_HOST`      | `127.0.0.1`    | Wyoming TTS engine (wyoming-piper). The container sets `host.docker.internal`. |
| `TTS_PORT`      | `10200`        | wyoming-piper's default port.                        |
| `TTS_VOICE`     | —              | Forces a voice by name; unset uses the engine's default. |
| `WATCH_SOURCE`  | `1`            | Exit when `server.js` changes so the supervisor restarts it. `0` disables. |
| `WATCH_POLL_MS` | `2000`         | mtime poll interval for that watcher.                |

---

## Speech to text

`POST /stt` takes raw audio and returns text. It is what the mic button uses, and it exists so the
browser never has to talk to anything but this server — the page's CSP is `connect-src 'self'`, and
every request it makes is root-relative, so the whole feature works unchanged behind a reverse proxy.

The body is **raw 16 kHz mono signed-16-bit little-endian PCM** — no WAV header, no container. The
format can be declared with `?rate=`, `?width=` and `?channels=`, though only 16-bit mono is accepted
today; the default is `rate=16000&width=2&channels=1`. Audio is capped at 8 MiB (~4 minutes). The
response is `{ text, audioMs, tookMs }`.

```bash
# transcribe a 16 kHz mono WAV by skipping its 44-byte header
tail -c +45 sample.wav | curl -s -X POST --data-binary @- \
  -H 'content-type: application/octet-stream' http://127.0.0.1:3901/stt
```

Under the hood the server speaks the [Wyoming protocol](https://github.com/rhasspy/wyoming) to a
local **wyoming-whisper** container on port 10300, over a plain TCP socket via `node:net` — so the
zero-dependency rule survives. Audio is sent as `transcribe` → `audio-start` → `audio-chunk`… →
`audio-stop`, and the engine answers with one `transcript` event and closes the connection.

> **Why Whisper and not Ollama?** Ollama serves text and vision models only — it has no
> speech-to-text models, so it cannot do this job at all. Whisper is the local engine for it.

**Testing it without a microphone** — `tools/stt-selftest.js` asks the local **wyoming-piper** TTS
container to speak a sentence, saves it as a WAV, pipes it through `/stt`, and checks the transcript
came back as the same sentence. Zero dependencies, no mic, no browser:

```bash
node tools/stt-selftest.js                                   # round-trip a default sentence
node tools/stt-selftest.js --text "check the widget report"  # say something specific
node tools/stt-selftest.js recording.wav                     # transcribe an existing 16-bit WAV
```

**Testing the page without a browser** — `tools/ui-selftest.js` runs the page's inline JS against a
stub DOM and asserts the things you cannot see by looking: that a blocked microphone explains itself
loudly and stickily, that permission-denied and no-device and transcription failures each say
something different, that auto-focus happens on desktop and never on touch, and that a browser with
no audio APIs cannot take the messaging half of the page down with it.

```bash
node tools/ui-selftest.js
```

It now also drives conversation mode end to end — utterance capture, the transcription queue, the
noise filter, spoken replies, and the echo gate described in
[Why it cannot hear itself](#why-it-cannot-hear-itself).

---

## Text to speech

`POST /tts` takes text and returns spoken audio. It is what the speaker button uses, and like `/stt`
it exists so the browser never talks to anything but this server.

The body is JSON — `{"text": "…"}`, capped at 2000 characters. The response is a **16-bit mono
RIFF/WAVE** file (`audio/wav`) at whatever rate the engine produces, typically 22050 Hz, with
`content-length` set. WAV rather than raw PCM because the browser has to decode it: a 44-byte header
is the difference between `decodeAudioData` working everywhere and hand-rolling a PCM reader. Two
extra response headers, `x-audio-ms` and `x-took-ms`, carry what a binary body cannot.

```bash
curl -s -X POST http://127.0.0.1:3901/tts \
  -H 'content-type: application/json' \
  -d '{"text":"forty two widgets are on hand"}' -o reply.wav
```

Under the hood this is the **same Wyoming client** `/stt` uses, pointed at the local
**wyoming-piper** container on port 10200 instead of whisper on 10300 — same wire format, same
socket lifecycle, one shared `wyomingExchange()`. Sending `synthesize` gets back `audio-start`, a run
of `audio-chunk` payloads and `audio-stop`; the chunks are collected rather than streamed so the
response can carry a correct header and length.

`/tts` is deliberately a **dumb primitive**, exactly like `/stt`: it speaks what it is given and
knows nothing about the conversation. Deciding *what is worth listening to* — stripping URLs,
collapsing code blocks — belongs to the page, where it can be seen and tuned.

**Testing it without a speaker** — `tools/tts-selftest.js` asks `/tts` for audio and checks it is a
well-formed WAV whose header agrees with its body, that it is **not silence** (a TTS leg returning
the right number of zero bytes passes every other check), that its length is plausible — and then
feeds it straight back into `/stt` and compares the transcript to the input. That round trip, text →
piper → WAV → whisper → text, is the strongest evidence available without ears:

```bash
node tools/tts-selftest.js
node tools/tts-selftest.js --text "check the widget report"
node tools/tts-selftest.js --keep     # leaves the WAV in data/tmp so you can listen to it
```

`tools/voice-lib.js` holds the Wyoming client and WAV/resampling helpers both self-tests share. It
is a local module, not a dependency — the zero-dependency rule is about npm, not about file count.

---

## Testing voice by hand

Microphones and speakers cannot be driven headlessly, so these are the steps a person has to run.
Do them on the **HTTPS** hostname (the mic is withheld from plain-http pages).

1. **Spoken replies alone.** Tap the **speaker** button in the header — it should stop being struck
   through. From another terminal, answer a message:
   `curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/result -H 'content-type: application/json' -d '{"result":"forty two widgets are on hand"}'`.
   The reply should be read aloud within a second or two. Reload the page: the same reply must
   **not** be read again.
2. **Condensing.** Post a result containing a URL and a fenced code block. It must say "a link" and
   "a code block" rather than spelling either out, while the surrounding sentence survives intact.
3. **Conversation, one turn.** Tap the speech-bubble button, allow the mic, wait for
   "Listening — go ahead.", say a short sentence, then stop. It should transcribe, post, and be back
   at "Listening — go ahead." **without another tap**.
4. **THE ECHO TEST — the one that matters.** With conversation mode running and the speaker **on**,
   have an agent post a reply so it is spoken **out loud on the phone's loudspeaker, not
   headphones**. While it is talking, the status must read "Speaking — mic off." and the button must
   turn blue. When it finishes, **no new message may appear in the thread.** Repeat it with a long
   reply and with the volume high. If a phantom message ever appears, raise `C.SETTLE_MS` in
   `public/index.html` first — Bluetooth speakers are the likely culprit.
5. **Talking over the queue.** Say two sentences back to back, barely pausing. Both must arrive, in
   the order you said them.
6. **Stopping.** Tap the button (or **Stop**) mid-reply. Audio must cut instantly, the recording
   indicator must go out immediately, and nothing may post afterwards.
7. **Noise.** Cough, tap the desk, say nothing for a minute. No messages may be posted.
8. **iOS specifics.** Lock the phone or switch apps mid-conversation, then come back — the page must
   either resume or say what it is doing, never sit silently dead. If the first reply is silent,
   that is the autoplay policy: the page should have told you to press the speaker button.

> **Known iOS caveat, unverified here:** while a `getUserMedia` stream is live, iOS may route output
> to the earpiece at reduced volume. The mic gate mutes the track but does not release it. If
> conversation replies sound quiet on an iPhone, that is why — use headphones, or say so and the
> gate can be changed to fully stop and re-acquire the track between turns.

---

## Why it cannot hear itself

With the microphone live and a reply playing out of the same device, the obvious failure is that the
page transcribes its **own** voice, posts it as your next message, gets a reply to that, speaks it,
hears it again — forever, into a real queue that agents act on. Preventing that is the single most
important correctness property of conversation mode, so it does not rest on one mechanism:

| # | Defence | Why it is there |
| - | ------- | --------------- |
| 1 | `track.enabled = false` on the mic track for the whole speaking turn | The browser hands the page digital silence at the track level. This holds even if every line of JS above it is wrong. |
| 2 | The frame handler returns immediately while gated | Nothing is buffered and no loudness is measured, so end-of-utterance cannot fire. |
| 3 | Whatever was half-captured when the gate closed is discarded | No fragment can be stitched onto the next utterance. |
| 4 | A 500 ms settle delay after playback ends | Room reverb, speaker ring-out and Bluetooth latency all outlive the `ended` event. |
| 5 | A transcript that overlaps what was just said is dropped as an echo | The last line of defence: catches leakage even if 1-4 all failed. Overlap is measured against what was *heard*, so a short fragment of a long reply is still caught. |
| 6 | `echoCancellation: true` on the capture stream | Real AEC where the device offers it. A bonus, never the defence — many devices ignore the hint, and none can cancel a loudspeaker across the room. |

The gate is closed for the **whole** turn, synthesis included, rather than only while audio is
playing. That costs about a second of listening and removes any window in which playback could start
part-way through an utterance already being recorded.

Defence 5 is deliberately conservative: it only applies within 4 s of speaking, only to transcripts
of two or more words, and only at 70% word overlap — so answering "yes, forty two" right after the
agent said "forty two widgets" is not eaten. When it does drop something it says **"Ignored my own
voice."** in the status bar rather than silently discarding it, and reports it to `/client-log`.

**This is tested, not asserted.** `tools/ui-selftest.js` drives the real state machine frame by
frame: it starts a conversation, pushes an agent reply through the SSE path, then pours three
seconds of loud audio into the microphone *while the reply is playing* — exactly what acoustic
feedback looks like — and asserts that no `/stt` call and no `/tasks` post happen. It then feeds
audio during the settle delay (still ignored), waits for the gate to lift, and feeds an utterance
whose transcript is the reply verbatim, asserting defence 5 catches it while a genuinely different
utterance immediately afterwards still posts normally.

---

## Staying up to date

The copy of the page this machine serves is meant to always be the latest merged code, with nobody
driving. Two pieces, no Docker socket and no webhooks:

- **`relay-queue-sync`** — an `alpine/git` sidecar in the same compose file. Every 60 s it runs
  `git fetch origin` and `git merge --ff-only origin/main` in the checkout.
  **It is fast-forward only and never resets**, so local commits that are not on `origin/main` are
  kept and the tree is left untouched rather than clobbered. With no `origin` configured (as now,
  until the repo is published) it idles quietly instead of erroring.
- **self-restart** — `server.js` watches its own file and exits cleanly when it changes;
  `restart: unless-stopped` brings it back a moment later on the new code, and replaying
  `events.jsonl` makes that lossless. So a merge to `main` deploys itself within about a minute.
  The UI needs none of this: `public/index.html` is re-read whenever its mtime changes.

  It watches with **both** `fs.watch` and an `fs.watchFile` mtime poll on purpose. Across a Windows
  bind mount inotify does not fire — verified here, the mtime poll is what actually catches it — so
  the poll is the backstop that makes this work at all on this machine.

Because a sync loop is writing to the checkout, **agents should not commit straight into it** once
the repo is published — work on a branch or a worktree and merge on GitHub. See
`.github-drafts/PUBLISH.md`.

---

## The thread model

There is **one** record type and **one** write path. A message from the human *is* the task; the
agent's reply *is* that task's result. Nothing new is stored:

```
task record                         thread entries derived from it
-----------------------------       ----------------------------------------------
{ role:"user", instruction:"…",  ->  { id:"<id>",    role:"user",  text:<instruction> }
  result:"…" }                  ->  { id:"<id>:r",  role:"agent", text:<result>, replyTo:"<id>" }
```

`GET /thread` is a **read-only projection** of the same task records, flattened into chronological
order. Every task yields one entry carrying its role (`"user"` unless stated otherwise), and a task
that has a result *also* yields a derived `role:"agent"` entry with id `<taskId>:r` and `replyTo`
pointing at its parent.

**So an agent replies to the human with exactly one call: `POST /tasks/:id/result`.** There is no
separate reply endpoint, and claim/result semantics are completely unchanged.

A thread entry:

```json
{
  "id": "msjfwakm-pgrjbw",
  "role": "user",
  "text": "sample: how many widgets are left?",
  "ts": "2026-01-01T00:00:00.000Z",
  "status": "pending",
  "rev": "2026-01-01T00:00:00.000Z"
}
```

`ts` is immutable and sets display order. **`rev`** is the last-changed time —
`max(ts, claimedAt, resultTs)` — and is what `since=` filters on, so a status change
(`pending` -> `claimed` -> `done`) reaches an incrementally polling client even though `ts` never
moves. Clients track the highest `rev` they have seen and upsert entries by `id`.

## Task lifecycle

```
POST /tasks                 ->  status: pending    (role: "user")
POST /tasks/:id/claim       ->  status: claimed    (409 if already claimed or done)
POST /tasks/:id/result      ->  status: done       (409 if already done)
```

`claim` is optional — you may post a result straight onto a `pending` task. A task takes **one**
result, so each message gets one reply.

In the UI, `pending` / `claimed` / `done` are shown on your own messages as
**pending** / **claimed** / **answered**.

**`relayed` is a separate axis from `status`.** It defaults to `false` and means "the Communicator
has already shown this result to the human". A task can be `done` but not yet relayed; that is
exactly the set you want to poll for. `unread=true` is shorthand for `relayed=false`.

A task record:

```json
{
  "id": "msjfwakm-pgrjbw",
  "role": "user",
  "instruction": "sample: summarise the widget report",
  "from": "communicator",
  "ts": "2026-01-01T00:00:00.000Z",
  "status": "pending",
  "claimedBy": null,
  "claimedAt": null,
  "result": null,
  "resultTs": null,
  "relayed": false,
  "relayedAt": null
}
```

All timestamps are ISO 8601 and are set server-side. `id` is URL-safe (base36 time + random).

`role` was added alongside the UI and is always **set by the server** — `role`, `id`, `ts`, `status`
and `relayed` in a request body are ignored. Records written before `role` existed replay as
`role:"user"`, so old logs load unchanged.

`instruction` is capped at **8000 characters** (`400` above that). `result` is not capped beyond the
1 MiB body limit, since it comes from the trusted agent side.

---

## curl cheat-sheet

Every command is copy-pasteable as-is (Git Bash). Add `-i` to see status codes.

**Health + queue counts** — returns `{status, name, version, counts:{pending,claimed,done,unrelayed}, uptimeSec}`.

```bash
curl -s http://127.0.0.1:3901/health
```

**Create a task** — returns `201` and the new task record (grab `.id` from it). Always `role:"user"`.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks \
  -H 'content-type: application/json' \
  -d '{"instruction":"sample: check the widget inventory","from":"communicator"}'
```

`text` is accepted as an alias for `instruction` (it is what the UI sends); the response always
returns `instruction`. These two are identical:

```bash
curl -s -X POST http://127.0.0.1:3901/tasks -H 'content-type: application/json' -d '{"text":"sample: hello"}'
curl -s -X POST http://127.0.0.1:3901/tasks -H 'content-type: application/json' -d '{"instruction":"sample: hello"}'
```

**List all tasks** — returns `{count, tasks:[...]}` in creation order.

```bash
curl -s http://127.0.0.1:3901/tasks
```

**List only pending tasks** — what the Coordinator polls for new work.

```bash
curl -s 'http://127.0.0.1:3901/tasks?status=pending'
```

**Claim a task** — returns `200` + the task with `status:"claimed"`; `404` unknown id, `409` if already claimed or done.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/claim \
  -H 'content-type: application/json' \
  -d '{"by":"coordinator"}'
```

**Post a result — this is also how an agent replies to the human.** Returns `200` + the task with
`status:"done"` and `resultTs` set; `409` if it already has a result. The reply shows up in the UI
thread as a `role:"agent"` bubble under the message it answers. One call, nothing else needed:

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/result \
  -H 'content-type: application/json' \
  -d '{"result":"sample: 42 widgets on hand, 3 backordered"}'
```

**Read the thread** — the human+agent conversation in chronological order, oldest first.

```bash
curl -s http://127.0.0.1:3901/thread
```

**Poll the thread incrementally** — `since` filters on `rev` (last-changed), **strictly after**, and
accepts ISO 8601 or epoch ms. This is what the UI does every ~3 s; it returns new messages, new
replies *and* status changes to messages you have already seen.

```bash
curl -s 'http://127.0.0.1:3901/thread?since=2026-01-01T00:00:00Z'
```

**Read the tail of the thread** — on `/thread`, `limit` takes the **most recent** N entries (a thread
is read from the end). Note this is the opposite of `/tasks?limit=`, which takes the first N.

```bash
curl -s 'http://127.0.0.1:3901/thread?limit=20'
```

**Get finished results the human has not seen yet** — the Communicator's main poll; returns `{count, tasks:[...]}` of `done` + `relayed:false`.

```bash
curl -s 'http://127.0.0.1:3901/results?unread=true'
```

**Mark a result as shown to the human** — returns `200` + the task with `relayed:true`; idempotent, repeat calls keep the original `relayedAt`.

```bash
curl -s -X POST http://127.0.0.1:3901/tasks/REPLACE_ID/relayed
```

**Get one task by id** — returns the single task record, or `404`.

```bash
curl -s http://127.0.0.1:3901/tasks/REPLACE_ID
```

**Anything newer than a timestamp** — `since` accepts ISO 8601 or epoch ms and filters on `ts`, **strictly after**.

```bash
curl -s 'http://127.0.0.1:3901/tasks?since=2026-01-01T00:00:00Z'
```

**Combine filters** — `status`, `unread`, `since` and `limit` all stack; `limit` takes the first N.

```bash
curl -s 'http://127.0.0.1:3901/tasks?status=done&unread=true&limit=5'
```

### Handy one-liners

**Answer the human's oldest waiting message in one line** — the whole agent loop, condensed:

```bash
curl -s 'http://127.0.0.1:3901/tasks?status=pending&limit=1' | grep -o '"id": "[^"]*"' | cut -d'"' -f4 \
  | xargs -I{} curl -s -X POST "http://127.0.0.1:3901/tasks/{}/result" \
      -H 'content-type: application/json' -d '{"result":"sample: on it — 42 widgets on hand"}'
```

Create a task and keep its id:

```bash
ID=$(curl -s -X POST http://127.0.0.1:3901/tasks -H 'content-type: application/json' \
  -d '{"instruction":"sample task","from":"communicator"}' | grep -o '"id": "[^"]*"' | cut -d'"' -f4)
echo "$ID"
```

Send a multi-line or quote-heavy result without fighting the shell:

```bash
curl -s -X POST "http://127.0.0.1:3901/tasks/$ID/result" \
  -H 'content-type: application/json' \
  --data-binary @- <<'JSON'
{"result":"sample: line one\nline two with \"quotes\""}
JSON
```

### Endpoint summary

| Method | Path                  | Purpose                                                        |
| ------ | --------------------- | -------------------------------------------------------------- |
| GET    | `/`                   | **new** — the mobile web UI (`text/html`; `503` if the page file is missing) |
| GET    | `/health`             | liveness + counts                                               |
| POST   | `/tasks`              | create (`400` if `instruction`/`text` missing or over 8000 chars) |
| GET    | `/tasks`              | list; `status` `unread` `since` `limit` (first N)               |
| GET    | `/tasks/:id`          | one task                                                        |
| POST   | `/tasks/:id/claim`    | pending -> claimed (`404`/`409`)                                |
| POST   | `/tasks/:id/result`   | -> done, **and posts the agent's reply into the thread** (`404`/`409`) |
| GET    | `/results`            | done tasks only; `unread` `since` `limit`                       |
| POST   | `/tasks/:id/relayed`  | mark shown to human (idempotent)                                |
| GET    | `/thread`             | chronological human+agent view; `since` (on `rev`) `limit` (last N) |
| GET    | `/events`             | **new** — Server-Sent Events; every change pushed as it happens  |
| POST   | `/stt`                | raw PCM in, `{text}` out, via the local Whisper engine           |
| POST   | `/tts`                | **new** — `{text}` in, a WAV out, via the local piper engine     |
| POST   | `/client-log`         | **new** — one diagnostic line from the browser into the container log |

`POST /client-log` stores nothing and touches no queue state; it only writes a rate-limited,
control-character-stripped line to stdout. It exists because the UI's real home is a phone, where
there is no console to read and "the mic did nothing" is otherwise undebuggable.

Changed in 1.3.0, all backward compatible: `POST /tts` speaks text through the local piper engine,
and the page gained hands-free conversation mode and spoken replies. No existing endpoint, record or
curl call changed.
Changed in 1.2.0, all backward compatible: `GET /events` pushes changes live (polling still works
and is still the fallback), and `POST /stt` transcribes audio. `/health` gained a `streams` count.
Changed in 1.1.0: task records gained a server-set `role`; `POST /tasks` accepts `text` as an alias
for `instruction` and caps it at 8000 chars. Every pre-1.1.0 record and every pre-1.1.0 curl call
keeps working exactly as before.

Unknown routes return `404` JSON, wrong methods `405`, malformed JSON bodies `400`. The server
never crashes on bad input.

---

## Data & git

Queue contents live in **`data/events.jsonl`** — one JSON event per line, append-only:

```
{"t":"create","task":{...}}
{"t":"patch","id":"msjfwakm-pgrjbw","patch":{"status":"claimed",...}}
```

`data/` is **gitignored** and must stay that way — it holds real message text. Only code and docs are
committed. To wipe the queue, stop the service, delete `data/events.jsonl`, start it again.

`data/ui/` is **no longer used** — compose now mounts the repo, so the container reads
`public/index.html` directly. If an old copy is still lying around, delete it.

`data/tmp/` holds throwaway artefacts from the voice self-tests (the WAVs they synthesise). Also
not queue state, also safe to delete.

On boot the log is replayed and a torn final line (from a hard kill mid-write) is skipped rather
than fatal; the startup log reports `N events replayed, M skipped`.

The log grows forever. This is intentional — it is the durability mechanism and the volumes here
are tiny. If it ever gets unwieldy, archive the file and restart.
