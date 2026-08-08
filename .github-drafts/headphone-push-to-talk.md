# Push-to-talk from a Bluetooth headphone button

**Labels:** `feature`, `voice`, `design-ready`
**Depends on:** `make-ui-a-pwa.md`, `https-for-mic-access.md`

## Why

Dictation still costs one tap on the screen. The goal is to start dictation **without taking the
phone out** — squeeze the headphone button, talk, and have the message send itself. Combined with
the existing automatic end-of-speech detection, that makes the whole loop hands-free.

## The idea

A web page cannot listen for Bluetooth AVRCP buttons directly. But it *can* if it is the thing
currently playing media: the OS routes the headset's play/pause to whatever holds the media session.
So — **play a silent looping audio track, claim the Media Session, and treat play/pause as the
push-to-talk trigger.**

```
headphone button ──AVRCP──> OS media controls ──> MediaSession "play"/"pause" action
                                                       └──> startVoice() / stopVoice()
```

## Design

**1. Hold a media session.**
Play a short silent audio loop (a fraction of a second of digital silence, generated in-page via
WebAudio or a tiny inline data: URI, looped) through an `<audio>` element. It must be a real element
— a WebAudio-only graph does not reliably register a media session. Start it on the first user
gesture; autoplay policies will not allow it before that.

**2. Claim the handlers.**

```js
navigator.mediaSession.metadata = new MediaMetadata({ title: 'relay — dictate', artist: 'relay' });
navigator.mediaSession.setActionHandler('play',  onPtt);
navigator.mediaSession.setActionHandler('pause', onPtt);
navigator.mediaSession.playbackState = 'playing';
```

**3. Toggle on either action.** A headset sends `play` or `pause` depending on what the OS thinks
the current state is, and that state drifts. Do not try to track it — treat **both** as one "button
pressed" event and toggle dictation:

```js
function onPtt() {
  if (vox) stopVoice(vox.phase === 'speak' ? 'done' : 'cancel');
  else startVoice();
  navigator.mediaSession.playbackState = 'playing'; // re-assert; never actually pause the loop
}
```

Debounce ~300 ms: some headsets fire both actions for one press.

**4. Never release the session.** If the silent track actually pauses, the OS may hand the media
session to Spotify (or whatever is next) and the button stops reaching the page. Keep the element
playing always, re-assert `playbackState = 'playing'` after every action, and re-`play()` on
`onpause`.

**5. Feedback matters more than usual.** The user is not looking at the screen. Short distinct
audio cues — a rising blip when dictation opens, a falling one when it closes, an error tone if
`/stt` fails — should be generated in-page with WebAudio oscillators (no asset files, no CSP
change). The existing on-screen states stay for when they *are* looking.

## Known problems to solve, not hand-wave

- **This requires a PWA.** In a normal browser tab the media session dies when the tab is
  backgrounded or the screen locks — exactly when this feature is wanted. Installed to the home
  screen it survives. Hence the dependency.
- **iOS is the risk.** Safari's Media Session support for `play`/`pause` handlers is real but
  historically inconsistent, and iOS is aggressive about suspending `AudioContext` in the
  background. This needs testing on the actual phone before it is called done; if iOS will not
  cooperate, ship it for Android and say so.
- **Silent audio has a battery cost.** Measure it. Consider only holding the session while a
  "hands-free mode" toggle is on, rather than always.
- **It fights with music.** Claiming the media session means the headphone button no longer
  pauses Spotify. That is a real trade-off — it is why hands-free mode should be an explicit
  toggle the user turns on, not the default.
- **Screen-locked mic capture.** Confirm `getUserMedia` keeps delivering audio with the screen off
  in an installed PWA. If it does not, the whole feature is decorative.

## Acceptance criteria

- [ ] A "hands-free" toggle in the UI that starts/stops holding the media session, off by default.
- [ ] With it on, a single headphone-button press starts dictation; speaking and then stopping
      sends the message, with no screen interaction at all.
- [ ] Pressing again mid-dictation cancels/stops it.
- [ ] Works with the screen locked and the app backgrounded, installed as a PWA.
- [ ] Audio cues mark start, end and failure distinctly enough to use blind.
- [ ] Double-fire from a single press does not start-then-immediately-stop (debounce verified).
- [ ] Battery cost of the silent loop measured and written into the README.
- [ ] iOS and Android behaviour documented, including whichever one does not work.
