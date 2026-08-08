# Two-way voice conversation — what shipped, what is left

**Labels:** `feature`, `voice`
**Related:** `hands-free-voice-input.md`, `wake-word-hands-free.md`, `headphone-push-to-talk.md`

## What shipped

Talk to the relay without touching it, and hear the answers.

- **Conversation mode.** A toggle beside the one-shot mic. While on, the microphone stays open
  across turns: each utterance is endpointed, transcribed, posted as its own message
  (`from:"voice-conversation"`), and the page is listening again before the transcript comes back.
  Capture continues *during* transcription and utterances are queued, so talking over the engine
  does not lose anything and messages arrive in the order they were spoken.
- **Spoken replies.** `POST /tts` relays text to the local **wyoming-piper** container over the same
  Wyoming client `/stt` already used — one shared `wyomingExchange()`, still zero dependencies. It
  returns a WAV so the browser can `decodeAudioData` it. Muteable independently of the mic, and
  works on the plain-http LAN page where the mic cannot.
- **Condensing.** Replies are rewritten before being spoken on the rule *say what it is, not what it
  says*: URLs, code blocks, shell commands, file paths and long identifiers become short spoken
  labels. The characters are on screen; nobody needs a URL spelled out.
- **Six-layer echo suppression** so the page cannot transcribe its own voice. Documented in the
  README under "Why it cannot hear itself" and tested frame by frame in `tools/ui-selftest.js`.
- **Testing.** `tools/tts-selftest.js` round-trips text → piper → WAV → whisper → text. The UI
  self-test grew from 24 checks to 93, including pouring loud audio into the mic *while a reply
  plays* and asserting nothing is posted.

## Scoped and deliberately not built

**1. Barge-in (interrupting the agent by talking over it).** The mic is hard-gated while a reply
plays, so speaking over it does nothing by design — that gate is the primary echo defence, and
barge-in requires giving it up in favour of real AEC plus a voice-activity detector that can tell
your voice from the speaker's. On a phone loudspeaker that is not reliably solvable. The escape
hatch today is tapping **Stop**, which cuts playback instantly. Revisit only if the stiffness turns
out to be the main complaint in real use, and only with headphones as the supported configuration.

**2. Streaming / partial transcripts.** There is still a dead moment while whisper runs. Wyoming
supports streaming audio; whether `tiny-int8` gives useful partials is unknown. Inherited from
`hands-free-voice-input.md` item 4.

**3. Retry of a failed transcription.** In conversation mode a failed `/stt` drops that utterance —
you have to say it again. Keeping the PCM and offering a retry is the fix. Inherited item 5.

**4. Per-conversation voice settings.** Voice selection (`TTS_VOICE`), speaking rate, and the
endpointing constants are all env vars or code constants. A settings panel was not built.

**5. Wake word.** Unchanged from `wake-word-hands-free.md` — conversation mode still needs one tap
to start, which is a deliberate trade against holding the mic open indefinitely.

**6. iOS output routing.** While a `getUserMedia` stream is live, iOS may route playback to the
earpiece at low volume. The gate mutes the track (`enabled = false`) rather than stopping it, which
keeps the conversation loop reliable but leaves the audio session in record mode. Fully stopping and
re-acquiring the track between turns would likely fix it at the cost of a `getUserMedia` call per
turn and a possible `NotReadableError` mid-conversation. **Needs a real iPhone to decide.**

## Acceptance criteria for calling this done

- [ ] A full hands-free conversation held on the user's phone over HTTPS, on the loudspeaker,
      with no phantom messages.
- [ ] `C.SETTLE_MS` confirmed sufficient for the user's actual speaker (Bluetooth is the risk).
- [ ] A decision recorded on the iOS earpiece-routing trade-off, either way.
- [ ] The noise-phrase filter checked against a week of real use — no genuine message eaten.
- [ ] Verified on iOS Safari and Android Chrome.
