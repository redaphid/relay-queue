# Wake word so dictation needs no button at all

**Labels:** `feature`, `voice`, `speculative`
**Related:** `hands-free-voice-input.md`, `headphone-push-to-talk.md`

## Why

Dictation currently needs a tap, and the headphone-button design needs a squeeze. A wake word needs
neither — say "hey relay", talk, done. It is the only genuinely hands-free trigger.

This is worth filing because **the hard part is already installed**: an `openwakeword` container is
running on this machine on port **10400**, speaking the same Wyoming protocol that `/stt` already
implements for Whisper on 10300. Most of the client code exists and can be reused.

## Sketch

- Add `POST /wake` (or extend the existing Wyoming client) to relay PCM to port 10400 and return
  whether a wake word fired, and which one. The event types differ from ASR (`detect` / `detection`)
  but the framing is identical to what `wyomingEvent`/`wyomingDecoder` already do in `server.js`.
- On the page, when hands-free mode is on, keep a rolling buffer of the last ~2 s of mic audio and
  feed it to the detector continuously, then hand off to the existing `startVoice()` on a hit.

## The reasons this may not be worth doing

Write these down before building it:

- **Always-on mic.** The page would hold the microphone open indefinitely. On a phone that is a
  battery and privacy cost, and the OS mic indicator stays lit the whole time. This is a much bigger
  ask of the user than "tap the mic".
- **Continuous upload.** Streaming audio to the server nonstop is very different from the current
  burst-per-utterance model. Running detection *in the browser* instead (openWakeWord's models are
  small; ONNX Runtime Web is plausible) would avoid it — but that means a build step and a bundled
  model, which breaks the "one self-contained HTML file, zero dependencies" property the project has
  deliberately kept.
- **False positives send messages.** Unlike a smart speaker, a false trigger here posts into a real
  queue that agents act on. The bar for precision is higher than usual.
- **It may be redundant.** If the headphone button works, this may not be worth its cost. Decide
  that first.

## Acceptance criteria

- [ ] A decision recorded on server-side vs. in-browser detection, with the "self-contained page"
      trade-off stated explicitly.
- [ ] Wake word only active behind an explicit, off-by-default toggle.
- [ ] Measured false-positive rate over a normal day is low enough that it does not post junk.
- [ ] Battery cost measured on the phone and documented.
- [ ] A clear, always-visible indication that the mic is live.
