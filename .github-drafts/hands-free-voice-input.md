# Hands-free voice input — what shipped, what is left

**Labels:** `feature`, `voice`

## What shipped

Tap the mic, talk, stop talking — the message sends itself. No second tap.

- **Capture.** `AudioWorklet` pulls raw PCM off the mic and batches it into 512-sample frames. The
  page asks for a 16 kHz `AudioContext` outright (the browser resamples better than we can) and
  falls back to box-averaged downsampling from the native rate if the browser refuses. A
  `ScriptProcessorNode` path covers browsers without `AudioWorklet`. The worklet is built from a
  `Blob` so the page stays a single self-contained file.
- **Endpointing.** Ambient room level is measured for 400 ms, then the speech threshold is
  `max(RMS_FLOOR, ambient × NOISE_MULT)`. Speech starts after 120 ms above threshold and ends after
  **1200 ms** below it. Audio is trimmed to the speech plus a 250 ms pre-roll and 300 ms tail.
  Guards: give up after 8 s of nothing, hard cap at 60 s, discard sub-250 ms blips. Every constant
  is in one `V = {…}` object at the top of the voice section.
- **Transcription.** `POST /stt` relays the PCM to a local **wyoming-whisper** container over the
  Wyoming protocol using `node:net` — no new dependencies. Nothing leaves the machine.
- **Sending.** The transcript is *appended* to the composer (never overwriting a draft) and sent
  through the existing send path with `from:"voice"`, so a failed send leaves the words in the box
  exactly like a typed message.
- **Testing without a mic.** `node tools/stt-selftest.js` has the local wyoming-piper container
  speak a sentence and checks it comes back transcribed. Measured ~450-650 ms to transcribe 2.6 s
  of speech.

> **Why not Ollama?** It has no speech-to-text models — it serves text and vision only. Whisper is
> the right local engine, and it was already running on this machine.

## What is left

**1. The mic does not work off this machine.** Browsers only grant it to a secure context, and the
page is plain `http` on the LAN. This is the single biggest gap — the feature was built for a phone
and currently only runs at `http://localhost:3901` on the PC. See
[`https-for-mic-access.md`](https-for-mic-access.md).

**2. No review before send.** A misheard message is sent as-is. Options worth weighing: a ~2 s
"tap to edit" grace window (costs hands-free-ness), or leaning on the fact that the queue is a
conversation where a follow-up correction is cheap. Decide deliberately rather than by default.

**3. Endpointing is untuned against real use.** The constants are guesses that work in a quiet room.
Known weak spots: a noisy room can push the adaptive threshold so high nothing registers; a slow
speaker pausing to think gets cut off at 1.2 s. Consider exposing the constants in a settings panel,
or adapting the silence window to how long the user has been speaking.

**4. No partial transcripts.** The whole utterance is sent after the fact, so there is a visible
dead moment while Whisper runs. Streaming chunks to the engine and showing interim text would make
it feel immediate. Wyoming supports streaming audio; whether the local model gives useful partials
needs checking.

**5. Failure recovery is a dead end.** If `/stt` fails, the audio is dropped and the user is told to
try again — having *just* spoken a long message. At minimum, keep the last recording in memory and
offer a retry.

**6. No wake word, so it is not truly hands-free.** An `openwakeword` container is already running
on this machine on port 10400, speaking the same Wyoming protocol as Whisper. See
[`wake-word-hands-free.md`](wake-word-hands-free.md).

**7. Unverified on the real device.** Mic capture cannot be tested headlessly. The manual test steps
are in the PR/commit and in the README; iOS Safari in particular needs a real run.

## Acceptance criteria for calling this done

- [ ] Dictation works from the user's phone over HTTPS.
- [ ] Endpointing tuned against at least a week of real use; constants documented with the reasoning.
- [ ] A failed transcription can be retried without re-speaking.
- [ ] A decision recorded on review-before-send, either way.
- [ ] Verified on iOS Safari and Android Chrome.
